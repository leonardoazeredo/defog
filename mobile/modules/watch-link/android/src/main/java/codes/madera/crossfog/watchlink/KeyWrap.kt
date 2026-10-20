package codes.madera.crossfog.watchlink

import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Wraps a data key under a key-encryption key as `IV (12 bytes) || AES-GCM ciphertext and tag`.
 * The alias is bound in as AAD so a blob cannot be unwrapped under a different key's name.
 */
class KeyWrap(private val kek: SecretKey, alias: String) {
  private val aad = alias.toByteArray(Charsets.UTF_8)

  fun wrap(dek: ByteArray): ByteArray {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    // No IV passed: the Keystore refuses a caller-chosen one for keys that require randomized encryption.
    cipher.init(Cipher.ENCRYPT_MODE, kek)
    cipher.updateAAD(aad)
    return cipher.iv + cipher.doFinal(dek)
  }

  fun unwrap(blob: ByteArray): ByteArray {
    if (blob.size < IV_BYTES + TAG_BYTES) throw AEADBadTagException("wrapped key is too short")
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, kek, GCMParameterSpec(TAG_BYTES * 8, blob, 0, IV_BYTES))
    cipher.updateAAD(aad)
    return cipher.doFinal(blob, IV_BYTES, blob.size - IV_BYTES)
  }

  private companion object {
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
    const val TAG_BYTES = 16
  }
}
