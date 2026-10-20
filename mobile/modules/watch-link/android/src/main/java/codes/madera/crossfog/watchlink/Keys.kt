package codes.madera.crossfog.watchlink

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.SecureRandom
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

  @Synchronized
  fun keyState(): KeyState {
    val alias = keyStore.containsAlias(KEK_ALIAS)
    val file = databaseKeyFile.exists()
    return when {
      !alias && !file -> KeyState.FRESH
      alias && file -> KeyState.EXISTING
      else -> KeyState.LOST
    }
  }

  @Synchronized
  fun databaseKey(): ByteArray {
    return when (keyState()) {
      KeyState.FRESH -> createDatabaseKey()
      KeyState.EXISTING -> readDatabaseKey()
      KeyState.LOST -> throw KeyLostException("database key file and Keystore key do not match")
    }
  }

  @Synchronized
  fun stagingKey(): SecretKey = existingKey(STAGING_ALIAS) ?: generateKey(STAGING_ALIAS)

  private fun createDatabaseKey(): ByteArray {
    val dek = ByteArray(DATABASE_KEY_BYTES).also { SecureRandom().nextBytes(it) }
    val blob = KeyWrap(generateKey(KEK_ALIAS), KEK_ALIAS).wrap(dek)
    databaseKeyFile.parentFile?.mkdirs()
    // AtomicFile syncs before it renames, so a crash leaves either no file or the whole one.
    val atomic = AtomicFile(databaseKeyFile)
    val out = atomic.startWrite()
    try {
      out.write(blob)
      atomic.finishWrite(out)
    } catch (e: Exception) {
      atomic.failWrite(out)
      throw e
    }
    return dek
  }

  private fun readDatabaseKey(): ByteArray {
    val kek = existingKey(KEK_ALIAS) ?: throw KeyLostException("Keystore key is missing")
    try {
      return KeyWrap(kek, KEK_ALIAS).unwrap(databaseKeyFile.readBytes())
    } catch (e: GeneralSecurityException) {
      throw KeyLostException("database key file cannot be unwrapped", e)
    }
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
    private const val PROVIDER = "AndroidKeyStore"
    const val KEK_ALIAS = "crossfog.kek.v1"
    const val STAGING_ALIAS = "crossfog.staging.v1"
    private const val DATABASE_KEY_BYTES = 32
  }
}
