package codes.madera.crossfog.watchlink

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.UnrecoverableKeyException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** The database key was created once but its wrapped file or Keystore key is gone or unreadable. */
class KeyLostException(message: String, cause: Throwable? = null) : Exception(message, cause)

enum class KeyState(val wire: String) { FRESH("fresh"), EXISTING("existing"), LOST("lost") }

/**
 * Keys that must stay reachable from Kotlin while JS is not running, so they live here and not in
 * expo-secure-store. JS reads only the database key, through WatchLinkModule.
 */
class Keys(context: Context) {
  // noBackupFilesDir is outside Auto Backup and device transfer; a restored file would be undecryptable.
  internal val databaseKeyFile = File(File(context.noBackupFilesDir, "keys"), "db.key.v1")

  private val keyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

  fun keyState(): KeyState = synchronized(LOCK) {
    val alias = keyStore.containsAlias(KEK_ALIAS)
    val file = databaseKeyFile.exists()
    when {
      !alias && !file -> KeyState.FRESH
      alias && file -> KeyState.EXISTING
      else -> KeyState.LOST
    }
  }

  fun databaseKey(): ByteArray = synchronized(LOCK) {
    when (keyState()) {
      KeyState.FRESH -> createDatabaseKey()
      KeyState.EXISTING -> readDatabaseKey()
      KeyState.LOST -> throw KeyLostException("database key file and Keystore key do not match")
    }
  }

  /**
   * A new database key for a key that is lost. Refuses any other state: replacing a key that still
   * works would make the database it protects unreadable.
   */
  fun replaceLostDatabaseKey(): ByteArray = synchronized(LOCK) {
    check(keyState() == KeyState.LOST) { "the database key is not lost" }
    try {
      keyStore.deleteEntry(KEK_ALIAS)
    } catch (e: Exception) {
      // A failed delete is tolerated: createDatabaseKey generates under the same alias next and fails loudly if that cannot work.
    }
    databaseKeyFile.delete()
    createDatabaseKey()
  }

  fun stagingKey(): SecretKey =
    synchronized(LOCK) { existingKey(STAGING_ALIAS) ?: generateKey(STAGING_ALIAS) }

  private fun createDatabaseKey(): ByteArray {
    val dek = ByteArray(DATABASE_KEY_BYTES).also { SecureRandom().nextBytes(it) }
    val kek = generateKey(KEK_ALIAS)
    try {
      writeAtomically(KeyWrap(kek, KEK_ALIAS).wrap(dek))
    } catch (e: Exception) {
      // An alias without its file reads as a lost key; a failed first write must not leave one behind.
      try {
        keyStore.deleteEntry(KEK_ALIAS)
      } catch (cleanup: Exception) {
        e.addSuppressed(cleanup)
      }
      throw e
    }
    return dek
  }

  private fun writeAtomically(blob: ByteArray) {
    val dir = databaseKeyFile.parentFile!!
    check(dir.isDirectory || dir.mkdirs()) { "cannot create ${dir.path}" }
    // AtomicFile syncs before it renames, so a crash leaves either no file or the whole one.
    val atomic = AtomicFile(databaseKeyFile)
    val out = atomic.startWrite()
    try {
      out.write(blob)
      atomic.finishWrite(out)
    } catch (e: Exception) {
      try {
        atomic.failWrite(out)
      } catch (cleanup: Exception) {
        e.addSuppressed(cleanup)
      }
      throw e
    }
  }

  private fun readDatabaseKey(): ByteArray {
    val kek = try {
      existingKey(KEK_ALIAS)
    } catch (e: UnrecoverableKeyException) {
      throw KeyLostException("Keystore key cannot be used", e)
    } ?: throw KeyLostException("Keystore key is missing")
    // Only the failures caught below mean the key is lost; anything else (a busy Keystore, an
    // unreadable file) propagates because it may succeed on retry.
    val dek = try {
      KeyWrap(kek, KEK_ALIAS).unwrap(databaseKeyFile.readBytes())
    } catch (e: AEADBadTagException) {
      throw KeyLostException("database key file does not match the Keystore key", e)
    } catch (e: KeyPermanentlyInvalidatedException) {
      throw KeyLostException("Keystore key was invalidated", e)
    }
    if (dek.size != DATABASE_KEY_BYTES) throw KeyLostException("database key has the wrong length")
    return dek
  }

  private fun existingKey(alias: String): SecretKey? = keyStore.getKey(alias, null) as SecretKey?

  private fun generateKey(alias: String): SecretKey {
    // No user authentication and no StrongBox: a biometric change must not brick the database,
    // and StrongBox is slower and absent on many phones.
    val spec = KeyGenParameterSpec.Builder(
      alias,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
      .apply { init(spec) }
      .generateKey()
  }

  internal companion object {
    // Shared by every instance: they all use the same Keystore aliases and the same db.key.v1, so a
    // per-instance lock would not serialize two first runs racing on them.
    private val LOCK = Any()
    private const val PROVIDER = "AndroidKeyStore"
    const val KEK_ALIAS = "crossfog.kek.v1"
    const val STAGING_ALIAS = "crossfog.staging.v1"
    private const val DATABASE_KEY_BYTES = 32
  }
}
