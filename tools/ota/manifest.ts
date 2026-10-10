// Over-the-air JS updates without EAS (docs/OTA.md): turns an `expo export` into one signed update per platform,
// in the Expo Updates protocol v1 (https://docs.expo.dev/technical-specs/expo-updates-1/). Pure: the CLI
// (prepare.ts) reads the files, and the Worker serves the result byte for byte.
import { createHash, createSign } from "node:crypto";

import type { Platform } from "./protocol";

/** `metadata.json` written by `expo export`. Paths use the exporting OS's separator. */
export interface ExportMetadata {
  version: number;
  bundler: string;
  fileMetadata: Partial<Record<Platform, { bundle: string; assets: { path: string; ext: string }[] }>>;
}

export interface UpdateAsset {
  /** Base64URL SHA-256 of the file: the client checks every download against it. */
  hash: string;
  key: string;
  contentType: string;
  fileExtension?: string;
  url: string;
}

export interface UpdateManifest {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: UpdateAsset;
  assets: UpdateAsset[];
  metadata: Record<string, string>;
  extra: Record<string, unknown>;
}

/** A file of the update, stored once under its key (`assets/<key>`) however many updates share it. */
export interface UpdateFile {
  /** Path inside the export directory, with forward slashes. */
  path: string;
  key: string;
  contentType: string;
}

const CONTENT_TYPES: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  wav: "audio/wav",
  webp: "image/webp",
  xml: "application/xml",
};

export const contentTypeOf = (ext: string): string => CONTENT_TYPES[ext.toLowerCase()] ?? "application/octet-stream";

export const sha256Base64Url = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("base64url");

/** Hex, so keys stay distinct on a case-insensitive file system (the client names its cached files after them). */
const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The update's id: a UUID-shaped digest of everything the client would download, so exporting the same JS twice
 * gives the same id and the phone sees no new update.
 */
export function updateId(runtimeVersion: string, platform: Platform, launchKey: string, assetKeys: string[]): string {
  const h = sha256Hex([runtimeVersion, platform, launchKey, ...[...assetKeys].sort()].join("\n"));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface BuildManifestArgs {
  metadata: ExportMetadata;
  platform: Platform;
  /** The binary's runtime version (fingerprint policy): only builds with exactly this one take the update. */
  runtimeVersion: string;
  createdAt: Date;
  /** Reads a file of the export by its forward-slash path. */
  read: (path: string) => Uint8Array;
  /** Where the Worker serves `assets/<key>`, without a trailing slash. */
  baseUrl: string;
  /** The public Expo config (`Constants.expoConfig` in an update comes from here). */
  expoClient: Record<string, unknown>;
  /** The commit the bundle was built from, for the update history. */
  commit: string;
  /** Its title: the app's App update page shows it for a downloaded update (docs/UPDATES-SPEC.md §5.5). */
  message?: string;
}

export function buildManifest(args: BuildManifestArgs): { manifest: UpdateManifest; files: UpdateFile[] } {
  const platformFiles = args.metadata.fileMetadata[args.platform];
  if (!platformFiles) throw new Error(`the export has no ${args.platform} bundle`);

  const files: UpdateFile[] = [];
  const asset = (rawPath: string, contentType: string, ext?: string): UpdateAsset => {
    const path = rawPath.replaceAll("\\", "/");
    const bytes = args.read(path);
    const key = sha256Hex(bytes);
    if (!files.some((f) => f.key === key)) files.push({ path, key, contentType });
    return {
      hash: sha256Base64Url(bytes),
      key,
      contentType,
      ...(ext ? { fileExtension: `.${ext}` } : {}),
      url: `${args.baseUrl}/assets/${key}`,
    };
  };

  // The protocol ignores the launch asset's file extension, so it has none.
  const launchAsset = asset(platformFiles.bundle, "application/javascript");
  const assets = platformFiles.assets.map((a) => asset(a.path, contentTypeOf(a.ext), a.ext));

  return {
    manifest: {
      id: updateId(args.runtimeVersion, args.platform, launchAsset.key, assets.map((a) => a.key)),
      createdAt: args.createdAt.toISOString(),
      runtimeVersion: args.runtimeVersion,
      launchAsset,
      assets,
      metadata: { commit: args.commit, ...(args.message ? { message: args.message } : {}) },
      extra: { expoClient: args.expoClient },
    },
    files,
  };
}

/**
 * The directive that sends phones back to the JS embedded in their build. They apply it only if their build is older
 * than `commitTime`, and from the next cold start.
 */
export const rollbackDirective = (commitTime: Date): string =>
  JSON.stringify({ type: "rollBackToEmbedded", parameters: { commitTime: commitTime.toISOString() } });

/** A string item of an Expo SFV dictionary (RFC 8941 sf-string). */
const sfString = (s: string): string => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * The `expo-signature` header for a manifest or directive body: RSA-SHA256 over the exact bytes served, checked by
 * the app against `certs/certificate.pem`. The body must not be re-serialized after signing.
 */
export function signatureHeader(body: string, privateKeyPem: string, keyid = "main"): string {
  const sig = createSign("RSA-SHA256").update(body, "utf8").sign(privateKeyPem, "base64");
  return `sig=${sfString(sig)}, keyid=${sfString(keyid)}`;
}
