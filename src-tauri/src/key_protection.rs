use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const MAX_KEY_MATERIAL_BYTES: usize = 1024 * 1024;
const APPLICATION_ENTROPY: &[u8] = b"Canvink|DPAPI|notebook-key-material|v1";

#[derive(Debug, Error)]
enum KeyProtectionError {
    #[error("key material is empty or malformed")]
    InvalidInput,
    #[error("key material exceeds the supported size")]
    PayloadTooLarge,
    #[error("key material protection failed")]
    ProtectionFailed,
    #[error("key material unprotection failed")]
    UnprotectionFailed,
    #[cfg(not(windows))]
    #[error("key protection is unavailable on this platform")]
    UnsupportedPlatform,
}

impl KeyProtectionError {
    fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput => "invalidInput",
            Self::PayloadTooLarge => "payloadTooLarge",
            Self::ProtectionFailed => "protectionFailed",
            Self::UnprotectionFailed => "unprotectionFailed",
            #[cfg(not(windows))]
            Self::UnsupportedPlatform => "unsupportedPlatform",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyProtectionCommandError {
    code: &'static str,
    message: &'static str,
}

impl From<KeyProtectionError> for KeyProtectionCommandError {
    fn from(error: KeyProtectionError) -> Self {
        Self {
            code: error.code(),
            message: match error {
                KeyProtectionError::InvalidInput => "Key material is empty or malformed.",
                KeyProtectionError::PayloadTooLarge => "Key material exceeds the size limit.",
                KeyProtectionError::ProtectionFailed => "Key material could not be protected.",
                KeyProtectionError::UnprotectionFailed => {
                    "Protected key material could not be opened."
                }
                #[cfg(not(windows))]
                KeyProtectionError::UnsupportedPlatform => {
                    "Operating-system key protection is unavailable."
                }
            },
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedKeyMaterial {
    protected_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnprotectedKeyMaterial {
    material_base64: String,
}

fn max_encoded_bytes() -> usize {
    MAX_KEY_MATERIAL_BYTES.div_ceil(3) * 4
}

fn decode_strict_base64(value: String) -> Result<Zeroizing<Vec<u8>>, KeyProtectionError> {
    let encoded = Zeroizing::new(value);
    if encoded.is_empty() {
        return Err(KeyProtectionError::InvalidInput);
    }
    if encoded.len() > max_encoded_bytes() {
        return Err(KeyProtectionError::PayloadTooLarge);
    }
    let decoded = BASE64_STANDARD
        .decode(encoded.as_bytes())
        .map_err(|_| KeyProtectionError::InvalidInput)?;
    if decoded.is_empty() {
        return Err(KeyProtectionError::InvalidInput);
    }
    if decoded.len() > MAX_KEY_MATERIAL_BYTES {
        return Err(KeyProtectionError::PayloadTooLarge);
    }
    if BASE64_STANDARD.encode(&decoded) != encoded.as_str() {
        return Err(KeyProtectionError::InvalidInput);
    }
    Ok(Zeroizing::new(decoded))
}

fn encode_and_wipe(mut bytes: Zeroizing<Vec<u8>>) -> String {
    let encoded = BASE64_STANDARD.encode(bytes.as_slice());
    bytes.zeroize();
    encoded
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    struct LocalBlob(CRYPT_INTEGER_BLOB);

    impl LocalBlob {
        fn empty() -> Self {
            Self(CRYPT_INTEGER_BLOB::default())
        }

        fn copy_bounded(
            &mut self,
            failure: KeyProtectionError,
        ) -> Result<Vec<u8>, KeyProtectionError> {
            let length = self.0.cbData as usize;
            if self.0.pbData.is_null() || length == 0 {
                return Err(failure);
            }
            if length > MAX_KEY_MATERIAL_BYTES {
                return Err(KeyProtectionError::PayloadTooLarge);
            }
            // SAFETY: DPAPI returned pbData with exactly cbData readable bytes and
            // ownership remains with this LocalBlob until LocalFree in Drop.
            Ok(unsafe { std::slice::from_raw_parts(self.0.pbData, length) }.to_vec())
        }
    }

    impl Drop for LocalBlob {
        fn drop(&mut self) {
            if self.0.pbData.is_null() {
                return;
            }
            let length = self.0.cbData as usize;
            if length > 0 {
                // SAFETY: DPAPI allocated cbData writable bytes at pbData. They
                // are zeroized before releasing the allocation with LocalFree.
                unsafe { std::slice::from_raw_parts_mut(self.0.pbData, length) }.zeroize();
            }
            // SAFETY: DPAPI documents that output buffers are released by LocalFree.
            unsafe {
                LocalFree(self.0.pbData.cast());
            }
            self.0 = CRYPT_INTEGER_BLOB::default();
        }
    }

    fn input_blob(bytes: &mut [u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_mut_ptr(),
        }
    }

    fn protect_with_entropy_bytes(
        material: &mut Zeroizing<Vec<u8>>,
        entropy_bytes: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, KeyProtectionError> {
        let mut entropy = Zeroizing::new(entropy_bytes.to_vec());
        let input = input_blob(material.as_mut_slice());
        let entropy_blob = input_blob(entropy.as_mut_slice());
        let mut output = LocalBlob::empty();
        // SAFETY: all DATA_BLOB pointers are valid for the duration of the call;
        // optional UI/reserved pointers are null and UI is explicitly forbidden.
        let succeeded = unsafe {
            CryptProtectData(
                &input,
                null(),
                &entropy_blob,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.0,
            )
        };
        if succeeded == 0 {
            return Err(KeyProtectionError::ProtectionFailed);
        }
        Ok(Zeroizing::new(
            output.copy_bounded(KeyProtectionError::ProtectionFailed)?,
        ))
    }

    pub(super) fn protect(
        material: &mut Zeroizing<Vec<u8>>,
    ) -> Result<Zeroizing<Vec<u8>>, KeyProtectionError> {
        protect_with_entropy_bytes(material, APPLICATION_ENTROPY)
    }

    #[cfg(test)]
    pub(super) fn protect_with_wrong_entropy(
        material: &mut Zeroizing<Vec<u8>>,
    ) -> Result<Zeroizing<Vec<u8>>, KeyProtectionError> {
        protect_with_entropy_bytes(material, b"Canvink|DPAPI|wrong-domain|v1")
    }

    pub(super) fn unprotect(
        protected: &mut Zeroizing<Vec<u8>>,
    ) -> Result<Zeroizing<Vec<u8>>, KeyProtectionError> {
        unprotect_with_entropy_bytes(protected, APPLICATION_ENTROPY)
    }

    pub(super) fn protect_with_label(
        material: &mut Zeroizing<Vec<u8>>,
        label: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, KeyProtectionError> {
        protect_with_entropy_bytes(material, label)
    }

    pub(super) fn unprotect_with_entropy_bytes(
        protected: &mut Zeroizing<Vec<u8>>,
        entropy_bytes: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, KeyProtectionError> {
        let mut entropy = Zeroizing::new(entropy_bytes.to_vec());
        let input = input_blob(protected.as_mut_slice());
        let entropy_blob = input_blob(entropy.as_mut_slice());
        let mut output = LocalBlob::empty();
        // SAFETY: all DATA_BLOB pointers are valid for the duration of the call;
        // no description is requested and UI/reserved pointers are null.
        let succeeded = unsafe {
            CryptUnprotectData(
                &input,
                null_mut(),
                &entropy_blob,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.0,
            )
        };
        if succeeded == 0 {
            return Err(KeyProtectionError::UnprotectionFailed);
        }
        Ok(Zeroizing::new(
            output.copy_bounded(KeyProtectionError::UnprotectionFailed)?,
        ))
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub(super) fn protect(
        _material: &mut Zeroizing<Vec<u8>>,
    ) -> Result<Zeroizing<Vec<u8>>, KeyProtectionError> {
        Err(KeyProtectionError::UnsupportedPlatform)
    }

    pub(super) fn unprotect(
        _protected: &mut Zeroizing<Vec<u8>>,
    ) -> Result<Zeroizing<Vec<u8>>, KeyProtectionError> {
        Err(KeyProtectionError::UnsupportedPlatform)
    }
}

/// Current-user DPAPI for other secrets at rest (the desktop sign-in's
/// refresh token). `label` is the DPAPI entropy, so a blob made for one
/// purpose never opens as another. Windows only.
#[cfg(windows)]
pub(crate) fn protect_for(label: &[u8], material: &[u8]) -> Option<Vec<u8>> {
    let mut material = Zeroizing::new(material.to_vec());
    platform::protect_with_label(&mut material, label)
        .ok()
        .map(|protected| protected.to_vec())
}

#[cfg(windows)]
pub(crate) fn unprotect_for(label: &[u8], protected: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    let mut protected = Zeroizing::new(protected.to_vec());
    platform::unprotect_with_entropy_bytes(&mut protected, label).ok()
}

fn protect_encoded(material_base64: String) -> Result<ProtectedKeyMaterial, KeyProtectionError> {
    let mut material = decode_strict_base64(material_base64)?;
    let protected = platform::protect(&mut material)?;
    material.zeroize();
    Ok(ProtectedKeyMaterial {
        protected_base64: encode_and_wipe(protected),
    })
}

fn unprotect_encoded(
    protected_base64: String,
) -> Result<UnprotectedKeyMaterial, KeyProtectionError> {
    let mut protected = decode_strict_base64(protected_base64)?;
    let material = platform::unprotect(&mut protected)?;
    protected.zeroize();
    Ok(UnprotectedKeyMaterial {
        material_base64: encode_and_wipe(material),
    })
}

#[tauri::command]
pub async fn protect_key_material(
    material_base64: String,
) -> Result<ProtectedKeyMaterial, KeyProtectionCommandError> {
    tauri::async_runtime::spawn_blocking(move || protect_encoded(material_base64))
        .await
        .map_err(|_| KeyProtectionCommandError {
            code: "protectionFailed",
            message: "Key material could not be protected.",
        })?
        .map_err(KeyProtectionCommandError::from)
}

#[tauri::command]
pub async fn unprotect_key_material(
    protected_base64: String,
) -> Result<UnprotectedKeyMaterial, KeyProtectionCommandError> {
    tauri::async_runtime::spawn_blocking(move || unprotect_encoded(protected_base64))
        .await
        .map_err(|_| KeyProtectionCommandError {
            code: "unprotectionFailed",
            message: "Protected key material could not be opened.",
        })?
        .map_err(KeyProtectionCommandError::from)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn current_user_dpapi_round_trip_succeeds() {
        let material = BASE64_STANDARD.encode(b"private notebook key");
        let protected = protect_encoded(material).expect("key material protects");
        let opened =
            unprotect_encoded(protected.protected_base64).expect("key material unprotects");
        assert_eq!(
            BASE64_STANDARD
                .decode(opened.material_base64)
                .expect("result is Base64"),
            b"private notebook key"
        );
    }

    #[test]
    fn labelled_blobs_open_only_with_their_own_label() {
        let sealed = protect_for(b"Canvink|label-a", b"refresh token").expect("protects");
        assert_eq!(
            unprotect_for(b"Canvink|label-a", &sealed)
                .expect("opens")
                .as_slice(),
            b"refresh token"
        );
        assert!(unprotect_for(b"Canvink|label-b", &sealed).is_none());
        assert!(unprotect_encoded(BASE64_STANDARD.encode(&sealed)).is_err());
    }

    #[test]
    fn tampered_dpapi_blob_is_rejected() {
        let protected = protect_encoded(BASE64_STANDARD.encode(b"private notebook key"))
            .expect("key material protects");
        let mut bytes = BASE64_STANDARD
            .decode(protected.protected_base64)
            .expect("protected blob is Base64");
        let last = bytes.last_mut().expect("protected blob is non-empty");
        *last ^= 0x80;
        assert!(matches!(
            unprotect_encoded(BASE64_STANDARD.encode(bytes)),
            Err(KeyProtectionError::UnprotectionFailed)
        ));
    }

    #[test]
    fn blob_protected_with_wrong_entropy_is_rejected() {
        let mut material = Zeroizing::new(b"private notebook key".to_vec());
        let protected = platform::protect_with_wrong_entropy(&mut material)
            .expect("alternate-entropy DPAPI protection succeeds");
        let protected = BASE64_STANDARD.encode(protected.as_slice());
        assert!(matches!(
            unprotect_encoded(protected),
            Err(KeyProtectionError::UnprotectionFailed)
        ));
    }

    #[test]
    fn empty_malformed_and_oversized_material_are_rejected() {
        assert!(matches!(
            protect_encoded(String::new()),
            Err(KeyProtectionError::InvalidInput)
        ));
        assert!(matches!(
            protect_encoded("not base64".to_owned()),
            Err(KeyProtectionError::InvalidInput)
        ));
        let oversized = vec![7; MAX_KEY_MATERIAL_BYTES + 1];
        assert!(matches!(
            protect_encoded(BASE64_STANDARD.encode(oversized)),
            Err(KeyProtectionError::PayloadTooLarge)
        ));
    }
}
