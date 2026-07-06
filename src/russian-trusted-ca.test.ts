/**
 * Offline validation of the bundled Минцифры certificates. createSecureContext
 * silently swallows a corrupted PEM, so verify the chain here instead.
 */

import { X509Certificate } from "node:crypto";
import { describe, it, expect } from "vitest";
import { RUSSIAN_TRUSTED_ROOT_CA, RUSSIAN_TRUSTED_SUB_CA } from "./russian-trusted-ca.js";

describe("Russian Trusted CA bundle", () => {
  it("both PEMs parse as valid X.509 certificates", () => {
    expect(() => new X509Certificate(RUSSIAN_TRUSTED_ROOT_CA.trim())).not.toThrow();
    expect(() => new X509Certificate(RUSSIAN_TRUSTED_SUB_CA.trim())).not.toThrow();
  });

  it("Sub CA is issued by the Root CA", () => {
    const root = new X509Certificate(RUSSIAN_TRUSTED_ROOT_CA.trim());
    const sub = new X509Certificate(RUSSIAN_TRUSTED_SUB_CA.trim());
    expect(sub.checkIssued(root)).toBe(true);
    expect(sub.verify(root.publicKey)).toBe(true);
  });

  it("certificates are not expired (early warning window)", () => {
    for (const pem of [RUSSIAN_TRUSTED_ROOT_CA, RUSSIAN_TRUSTED_SUB_CA]) {
      const cert = new X509Certificate(pem.trim());
      const validTo = new Date(cert.validTo).getTime();
      // At least 30 days of validity remaining
      expect(validTo).toBeGreaterThan(Date.now() + 30 * 864e5);
    }
  });
});
