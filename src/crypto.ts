import crypto from 'node:crypto';
import fs from 'node:fs';

const MAGIC = Buffer.from('PWLE');
const VERSION = 0x01;
const HKDF_INFO = 'prowl-e2e-v1';

export interface KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

/** Generate an X25519 keypair, returning raw 32-byte keys. */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');

  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });

  return {
    publicKey: Buffer.from(pubJwk.x!, 'base64url'),
    privateKey: Buffer.from(privJwk.d!, 'base64url'),
  };
}

/** Read a 32-byte hex-encoded key from a file. */
export function loadPublicKey(filePath: string): Buffer {
  const hex = fs.readFileSync(filePath, 'utf-8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`Invalid public key file: expected 64 hex chars, got ${hex.length}`);
  }
  return Buffer.from(hex, 'hex');
}

/** Read a 32-byte hex-encoded private key from a file. */
export function loadPrivateKey(filePath: string): Buffer {
  const hex = fs.readFileSync(filePath, 'utf-8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`Invalid private key file: expected 64 hex chars, got ${hex.length}`);
  }
  return Buffer.from(hex, 'hex');
}

function rawKeyToX25519Public(raw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      x: raw.toString('base64url'),
    },
    format: 'jwk',
  });
}

function rawKeyToX25519Private(raw: Buffer): crypto.KeyObject {
  // PKCS8 DER for X25519 private key (48 bytes total):
  // SEQUENCE (46 bytes) {
  //   INTEGER 0 (version)
  //   SEQUENCE (5 bytes) { OID 1.3.101.110 }
  //   OCTET STRING (34 bytes) { OCTET STRING (32 bytes) { key } }
  // }
  const prefix = Buffer.from(
    '302e020100300506032b656e04220420',
    'hex',
  );
  return crypto.createPrivateKey({
    key: Buffer.concat([prefix, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

function deriveSharedKey(privateKeyObj: crypto.KeyObject, publicKeyObj: crypto.KeyObject): Buffer {
  const shared = crypto.diffieHellman({ privateKey: privateKeyObj, publicKey: publicKeyObj });
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 32));
}

/**
 * Encrypt plaintext using X25519 + AES-256-GCM.
 * Returns the binary wire format: MAGIC | VERSION | ephemeral_pub(32) | iv(12) | ciphertext+tag
 */
export function encrypt(plaintext: Buffer | string, recipientPubKey: Buffer): Buffer {
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf-8') : plaintext;

  // Generate ephemeral X25519 keypair
  const ephemeral = generateKeyPair();

  const ephPrivObj = rawKeyToX25519Private(ephemeral.privateKey);
  const recipPubObj = rawKeyToX25519Public(recipientPubKey);

  const aesKey = deriveSharedKey(ephPrivObj, recipPubObj);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(aesKey), iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([
    MAGIC,                          // 4 bytes
    Buffer.from([VERSION]),         // 1 byte
    ephemeral.publicKey,            // 32 bytes
    iv,                             // 12 bytes
    encrypted,                      // plaintext_len bytes
    authTag,                        // 16 bytes
  ]);
}

/**
 * Decrypt a PWLE wire-format buffer using the recipient's private key.
 */
export function decrypt(encrypted: Buffer, recipientPrivKey: Buffer): Buffer {
  if (encrypted.length < 49 + 16) {
    throw new Error('Encrypted data too short');
  }

  // Verify magic
  if (!encrypted.subarray(0, 4).equals(MAGIC)) {
    throw new Error('Invalid magic bytes — not a PWLE encrypted file');
  }

  const version = encrypted[4];
  if (version !== VERSION) {
    throw new Error(`Unsupported PWLE version: ${version}`);
  }

  const ephemeralPub = encrypted.subarray(5, 37);
  const iv = encrypted.subarray(37, 49);
  const ciphertextWithTag = encrypted.subarray(49);

  // Last 16 bytes are the GCM auth tag
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);

  const ephPubObj = rawKeyToX25519Public(ephemeralPub);
  const recipPrivObj = rawKeyToX25519Private(recipientPrivKey);

  const aesKey = deriveSharedKey(recipPrivObj, ephPubObj);

  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(aesKey), iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
