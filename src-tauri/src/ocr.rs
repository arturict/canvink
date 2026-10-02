use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_ENCODED_IMAGE_BYTES: usize = MAX_IMAGE_BYTES.div_ceil(3) * 4;
const MAX_LANGUAGE_TAG_CHARACTERS: usize = 64;
const MAX_IMAGE_PIXELS: u64 = 50_000_000;
const MAX_RESULT_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESULT_LINES: usize = 10_000;
const MAX_RESULT_WORDS: usize = 100_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrCommandError {
    code: &'static str,
    message: String,
}

impl OcrCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn task(message: impl Into<String>) -> Self {
        Self::new("ocrTaskFailed", message)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrRequest {
    data_base64: String,
    language_tag: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrBoundingBox {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrWord {
    text: String,
    bounding_box: OcrBoundingBox,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
    text: String,
    words: Vec<OcrWord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrRecognitionResult {
    engine: &'static str,
    language_tag: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text_angle: Option<f64>,
    lines: Vec<OcrLine>,
}

fn decode_request(request: OcrRequest) -> Result<(Vec<u8>, Option<String>), OcrCommandError> {
    if request.data_base64.is_empty() || request.data_base64.len() > MAX_ENCODED_IMAGE_BYTES {
        return Err(OcrCommandError::new(
            "imageTooLarge",
            format!("OCR image must decode to 1 to {MAX_IMAGE_BYTES} bytes"),
        ));
    }
    let bytes = BASE64_STANDARD
        .decode(&request.data_base64)
        .map_err(|_| OcrCommandError::new("invalidImage", "OCR image is not strict Base64"))?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(OcrCommandError::new(
            "imageTooLarge",
            format!("OCR image must decode to 1 to {MAX_IMAGE_BYTES} bytes"),
        ));
    }
    if BASE64_STANDARD.encode(&bytes) != request.data_base64 {
        return Err(OcrCommandError::new(
            "invalidImage",
            "OCR image is not canonical padded Base64",
        ));
    }
    if !is_supported_image(&bytes) {
        return Err(OcrCommandError::new(
            "invalidImage",
            "OCR accepts decoded PNG, JPEG, BMP, or TIFF image bytes only",
        ));
    }
    if let Some(language_tag) = request.language_tag.as_deref() {
        validate_language_tag(language_tag)?;
    }
    Ok((bytes, request.language_tag))
}

fn is_supported_image(bytes: &[u8]) -> bool {
    let png = bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    let jpeg = bytes.starts_with(&[0xff, 0xd8, 0xff]);
    let bmp = bytes.starts_with(b"BM");
    let tiff_little = bytes.starts_with(&[b'I', b'I', 0x2a, 0x00]);
    let tiff_big = bytes.starts_with(&[b'M', b'M', 0x00, 0x2a]);
    png || jpeg || bmp || tiff_little || tiff_big
}

fn validate_language_tag(language_tag: &str) -> Result<(), OcrCommandError> {
    if language_tag.is_empty()
        || language_tag.chars().count() > MAX_LANGUAGE_TAG_CHARACTERS
        || language_tag.starts_with('-')
        || language_tag.ends_with('-')
        || language_tag
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || byte == b'-'))
    {
        return Err(OcrCommandError::new(
            "invalidLanguage",
            "OCR language must be a bounded BCP-47 language tag",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn windows_error(context: &str, error: windows::core::Error) -> OcrCommandError {
    OcrCommandError::new("ocrUnavailable", format!("{context}: {error}"))
}

#[cfg(windows)]
struct WindowsRuntimeApartment;

#[cfg(windows)]
impl WindowsRuntimeApartment {
    fn initialize() -> Result<Self, OcrCommandError> {
        use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
            .map_err(|error| windows_error("could not initialize Windows Runtime", error))?;
        Ok(Self)
    }
}

#[cfg(windows)]
impl Drop for WindowsRuntimeApartment {
    fn drop(&mut self) {
        use windows::Win32::System::WinRT::RoUninitialize;

        unsafe { RoUninitialize() };
    }
}

#[cfg(windows)]
fn available_languages_windows() -> Result<Vec<String>, OcrCommandError> {
    use windows::Media::Ocr::OcrEngine;

    let _apartment = WindowsRuntimeApartment::initialize()?;
    let languages = OcrEngine::AvailableRecognizerLanguages()
        .map_err(|error| windows_error("could not list installed OCR languages", error))?;
    let mut result = Vec::with_capacity(languages.Size().unwrap_or(0) as usize);
    for index in 0..languages
        .Size()
        .map_err(|error| windows_error("could not inspect installed OCR languages", error))?
    {
        let language = languages
            .GetAt(index)
            .map_err(|error| windows_error("could not read an installed OCR language", error))?;
        let tag = language
            .LanguageTag()
            .map_err(|error| windows_error("could not read an OCR language tag", error))?
            .to_string_lossy();
        if tag.len() <= MAX_LANGUAGE_TAG_CHARACTERS && !result.contains(&tag) {
            result.push(tag);
        }
    }
    result.sort_by_key(|tag| tag.to_ascii_lowercase());
    Ok(result)
}

#[cfg(windows)]
fn recognize_windows(request: OcrRequest) -> Result<OcrRecognitionResult, OcrCommandError> {
    use windows::{
        Graphics::Imaging::BitmapDecoder,
        Media::Ocr::OcrEngine,
        Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
    };

    let (bytes, requested_language) = decode_request(request)?;
    let _apartment = WindowsRuntimeApartment::initialize()?;

    let stream = InMemoryRandomAccessStream::new()
        .map_err(|error| windows_error("could not allocate a local image stream", error))?;
    let writer = DataWriter::CreateDataWriter(&stream)
        .map_err(|error| windows_error("could not create a local image writer", error))?;
    writer
        .WriteBytes(&bytes)
        .map_err(|error| windows_error("could not stage the local image", error))?;
    writer
        .StoreAsync()
        .and_then(|operation| operation.join())
        .map_err(|error| windows_error("could not stage the local image", error))?;
    writer
        .DetachStream()
        .map_err(|error| windows_error("could not finalize the local image stream", error))?;
    stream
        .Seek(0)
        .map_err(|error| windows_error("could not rewind the local image stream", error))?;

    let decoder = BitmapDecoder::CreateAsync(&stream)
        .and_then(|operation| operation.join())
        .map_err(|error| windows_error("Windows could not decode this image", error))?;
    let width = decoder
        .PixelWidth()
        .map_err(|error| windows_error("could not inspect image width", error))?;
    let height = decoder
        .PixelHeight()
        .map_err(|error| windows_error("could not inspect image height", error))?;
    let maximum_dimension = OcrEngine::MaxImageDimension()
        .map_err(|error| windows_error("could not read Windows OCR image limits", error))?;
    if width == 0
        || height == 0
        || width > maximum_dimension
        || height > maximum_dimension
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return Err(OcrCommandError::new(
            "imageTooLarge",
            format!(
                "decoded image is {width}x{height}; Windows OCR permits at most {maximum_dimension}px per side and Canvink permits {MAX_IMAGE_PIXELS} pixels"
            ),
        ));
    }

    let installed = OcrEngine::AvailableRecognizerLanguages()
        .map_err(|error| windows_error("could not list installed OCR languages", error))?;
    let engine = if let Some(requested) = requested_language {
        let mut selected = None;
        for index in 0..installed
            .Size()
            .map_err(|error| windows_error("could not inspect installed OCR languages", error))?
        {
            let language = installed.GetAt(index).map_err(|error| {
                windows_error("could not read an installed OCR language", error)
            })?;
            let tag = language
                .LanguageTag()
                .map_err(|error| windows_error("could not read an OCR language tag", error))?
                .to_string_lossy();
            if tag.eq_ignore_ascii_case(&requested) {
                selected = Some(language);
                break;
            }
        }
        let language = selected.ok_or_else(|| {
            OcrCommandError::new(
                "languageNotInstalled",
                format!("Windows OCR language {requested} is not installed"),
            )
        })?;
        OcrEngine::TryCreateFromLanguage(&language)
            .map_err(|error| windows_error("could not create the requested OCR engine", error))?
    } else {
        OcrEngine::TryCreateFromUserProfileLanguages().map_err(|error| {
            windows_error("no installed user-profile OCR language is available", error)
        })?
    };
    let language_tag = engine
        .RecognizerLanguage()
        .and_then(|language| language.LanguageTag())
        .map_err(|error| windows_error("could not read the selected OCR language", error))?
        .to_string_lossy();
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .and_then(|operation| operation.join())
        .map_err(|error| windows_error("could not decode a software bitmap", error))?;
    let recognition = engine
        .RecognizeAsync(&bitmap)
        .and_then(|operation| operation.join())
        .map_err(|error| windows_error("Windows OCR recognition failed", error))?;

    let text = recognition
        .Text()
        .map_err(|error| windows_error("could not read OCR text", error))?
        .to_string_lossy();
    if text.len() > MAX_RESULT_TEXT_BYTES {
        return Err(OcrCommandError::new(
            "resultTooLarge",
            "OCR text exceeds the local result limit",
        ));
    }
    let text_angle = recognition
        .TextAngle()
        .ok()
        .and_then(|angle| angle.Value().ok());
    let native_lines = recognition
        .Lines()
        .map_err(|error| windows_error("could not read OCR lines", error))?;
    let line_count = native_lines
        .Size()
        .map_err(|error| windows_error("could not count OCR lines", error))?
        as usize;
    if line_count > MAX_RESULT_LINES {
        return Err(OcrCommandError::new(
            "resultTooLarge",
            "OCR result contains too many lines",
        ));
    }
    let mut lines = Vec::with_capacity(line_count);
    let mut word_count = 0usize;
    for line_index in 0..line_count {
        let native_line = native_lines
            .GetAt(line_index as u32)
            .map_err(|error| windows_error("could not read an OCR line", error))?;
        let line_text = native_line
            .Text()
            .map_err(|error| windows_error("could not read OCR line text", error))?
            .to_string_lossy();
        let native_words = native_line
            .Words()
            .map_err(|error| windows_error("could not read OCR words", error))?;
        let words_in_line = native_words
            .Size()
            .map_err(|error| windows_error("could not count OCR words", error))?
            as usize;
        word_count = word_count
            .checked_add(words_in_line)
            .ok_or_else(|| OcrCommandError::new("resultTooLarge", "OCR word count overflowed"))?;
        if word_count > MAX_RESULT_WORDS {
            return Err(OcrCommandError::new(
                "resultTooLarge",
                "OCR result contains too many words",
            ));
        }
        let mut words = Vec::with_capacity(words_in_line);
        for word_index in 0..words_in_line {
            let native_word = native_words
                .GetAt(word_index as u32)
                .map_err(|error| windows_error("could not read an OCR word", error))?;
            let rectangle = native_word
                .BoundingRect()
                .map_err(|error| windows_error("could not read an OCR word box", error))?;
            words.push(OcrWord {
                text: native_word
                    .Text()
                    .map_err(|error| windows_error("could not read OCR word text", error))?
                    .to_string_lossy(),
                bounding_box: OcrBoundingBox {
                    x: rectangle.X,
                    y: rectangle.Y,
                    width: rectangle.Width,
                    height: rectangle.Height,
                },
            });
        }
        lines.push(OcrLine {
            text: line_text,
            words,
        });
    }

    Ok(OcrRecognitionResult {
        engine: "windows-media-ocr",
        language_tag,
        text,
        text_angle,
        lines,
    })
}

#[tauri::command]
pub async fn ocr_available_languages() -> Result<Vec<String>, OcrCommandError> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(available_languages_windows)
            .await
            .map_err(|error| OcrCommandError::task(error.to_string()))?
    }
    #[cfg(not(windows))]
    Err(OcrCommandError::new(
        "unsupportedPlatform",
        "local OCR is available only on Windows",
    ))
}

#[tauri::command]
pub async fn ocr_recognize_image(
    request: OcrRequest,
) -> Result<OcrRecognitionResult, OcrCommandError> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || recognize_windows(request))
            .await
            .map_err(|error| OcrCommandError::task(error.to_string()))?
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        Err(OcrCommandError::new(
            "unsupportedPlatform",
            "local OCR is available only on Windows",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_requires_canonical_bounded_supported_images() {
        let bytes = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 1];
        let request = OcrRequest {
            data_base64: BASE64_STANDARD.encode(bytes),
            language_tag: Some("de-CH".into()),
        };
        assert_eq!(decode_request(request).unwrap().0, bytes);

        let malformed = OcrRequest {
            data_base64: "AQI".into(),
            language_tag: None,
        };
        assert_eq!(decode_request(malformed).unwrap_err().code, "invalidImage");
        let unsupported = OcrRequest {
            data_base64: BASE64_STANDARD.encode(b"not an image"),
            language_tag: None,
        };
        assert_eq!(
            decode_request(unsupported).unwrap_err().code,
            "invalidImage"
        );
    }

    #[test]
    fn language_tags_are_strict_and_bounded() {
        assert!(validate_language_tag("de-CH").is_ok());
        assert!(validate_language_tag("").is_err());
        assert!(validate_language_tag("../de").is_err());
        assert!(validate_language_tag(&"a".repeat(MAX_LANGUAGE_TAG_CHARACTERS + 1)).is_err());
    }
}
