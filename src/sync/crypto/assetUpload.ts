import { SYNC_PROTOCOL_VERSION } from "../types";
import { canonicalEncode, canonicalInteger, canonicalText } from "./encoding";
import { signDetached } from "./sodium";
import {
  CryptoProtocolError,
  ED25519_PRIVATE_KEY_BYTES,
  SHA256_BYTES,
  type DeviceSecretIdentity,
} from "./types";

export interface AssetUploadAuthorizationInput {
  notebookId: string;
  deviceId: string;
  encryptedHash: Uint8Array;
  encryptedSize: number;
  signer: DeviceSecretIdentity;
}

export function assetUploadAuthorizationPayload(
  input: Omit<AssetUploadAuthorizationInput, "signer">,
): Uint8Array {
  if (input.encryptedHash.byteLength !== SHA256_BYTES)
    throw new CryptoProtocolError(
      "invalid-input",
      "Encrypted asset hash must be 32 bytes.",
    );
  if (!Number.isSafeInteger(input.encryptedSize) || input.encryptedSize < 1)
    throw new CryptoProtocolError(
      "invalid-input",
      "Encrypted asset size is invalid.",
    );
  return canonicalEncode("canvink/asset-upload-authorization/v1", [
    ["protocolVersion", canonicalInteger(SYNC_PROTOCOL_VERSION)],
    ["notebookId", canonicalText(input.notebookId)],
    ["deviceId", canonicalText(input.deviceId)],
    ["encryptedHash", input.encryptedHash],
    ["encryptedSize", canonicalInteger(input.encryptedSize)],
  ]);
}

export async function createAssetUploadAuthorization(
  input: AssetUploadAuthorizationInput,
): Promise<Uint8Array> {
  if (
    input.signer.destroyed ||
    input.signer.signingPrivateKey.byteLength !== ED25519_PRIVATE_KEY_BYTES
  ) {
    throw new CryptoProtocolError(
      "destroyed-secret",
      "Device signing identity is unavailable.",
    );
  }
  if (input.signer.publicIdentity.deviceId !== input.deviceId)
    throw new CryptoProtocolError(
      "wrong-device",
      "Upload device does not match the signing identity.",
    );
  return signDetached(
    assetUploadAuthorizationPayload(input),
    input.signer.signingPrivateKey,
  );
}
