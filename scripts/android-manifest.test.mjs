import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = readFileSync("src-tauri/gen/android/app/src/main/AndroidManifest.xml", "utf8");

test("the Android app may read the network state, or the WebView reports online in airplane mode", () => {
  // Chromium's network change notifier needs ACCESS_NETWORK_STATE; without it navigator.onLine
  // never turns false and the sync status says "Reconnecting" instead of "Offline".
  assert.match(manifest, /<uses-permission android:name="android\.permission\.ACCESS_NETWORK_STATE"\s*\/>/);
  assert.match(manifest, /<uses-permission android:name="android\.permission\.INTERNET"\s*\/>/);
});
