package codes.madera.crossfog.watchlink

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Log
import java.io.File
import java.io.IOException
import java.security.UnrecoverableKeyException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * The database key was created once but its wrapped file or Keystore key is gone or unreadable.
 * `permanent` is set only for a failure no later read can fix (a bad tag, an invalidated Keystore
 * key, a key of the wrong length), and `keyState()` reads it as unreadable. `absent` is set when the
 * alias is there but the Keystore holds no key under it, which `keyState()` reads as lost. A restore
 * or a reset may replace a key in either state, never one that only failed to read this time.
 */
class KeyLostException(
  message: String,
  cause: Throwable? = null,
  val permanent: Boolean = false,
  val absent: Boolean = false,
) : Exception(message, cause)

/**
 * The key's state forbids the call (a key that works or may on a later read, no key to
 * replace, or a database file that exists). The one failure JS reads as ERR_INVALID_STATE; any
 * other IllegalStateException is a failure, not a refusal.
 */
class KeyRefusedException(message: String) : IllegalStateException(message)

/**
 * FRESH: neither the Keystore key nor the file. LOST: exactly one of them, or both with no key
 * behind the alias. UNREADABLE: both, but
 * the key can never be read (bad tag, invalidated Keystore key, wrong length). EXISTING: both, and
 * a read just now did not fail for good (a later one may still fail, e.g. on a busy Keystore).
 */
enum class KeyState(val wire: String) {
  FRESH("fresh"),
  EXISTING("existing"),
  LOST("lost"),
  UNREADABLE("unreadable"),
}

/**
 * Keys that must stay reachable from Kotlin while JS is not running, so they live here and not in
 * expo-secure-store. JS touches only the database key, through WatchLinkModule: it reads it, hands
 * in a new one in place of a lost or unreadable one, and drops such a key when no database exists.
 */
class Keys(
  context: Context,
  // expo-sqlite's default directory; the history database lives there as crossfog.db.
  private val sqliteDir: File = File(context.filesDir, "SQLite"),
  // A seam for the test of a Keystore that refuses to drop its entry.
  private val deleteAlias: ((String) -> Unit)? = null,
) {
  // noBackupFilesDir is outside Auto Backup and device transfer; a restored file would be undecryptable.
  internal val databaseKeyFile = File(File(context.noBackupFilesDir, "keys"), "db.key.v1")

  private val keyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

  fun keyState(): KeyState = synchronized(LOCK) {
    when (val present = presence()) {
      KeyState.EXISTING -> stateOfPresentKey { readDatabaseKey().fill(0) }
      else -> present
    }
  }

  /**
   * Which halves are present, with no read of the key: FRESH, LOST or (both present) EXISTING, which
   * may still be unreadable. A caller that is about to read the key anyway uses this and asks
   * `keyState()` only when that read fails, so a start unwraps the key once.
   */
  fun keyPresence(): KeyState = synchronized(LOCK) { presence() }

  // Only the committed file counts: AtomicFile's `db.key.v1.new` left by a kill before its rename
  // was never a usable key.
  private fun presence(): KeyState {
    val alias = keyStore.containsAlias(KEK_ALIAS)
    val file = databaseKeyFile.exists()
    return when {
      !alias && !file -> KeyState.FRESH
      alias && file -> KeyState.EXISTING
      else -> KeyState.LOST
    }
  }

  fun databaseKey(): ByteArray = synchronized(LOCK) {
    when (presence()) {
      KeyState.FRESH -> createDatabaseKey()
      KeyState.LOST -> throw KeyLostException(
        if (databaseKeyFile.exists()) "the Keystore key is missing" else "the database key file is missing",
      )
      else -> readDatabaseKey()
    }
  }

  /**
   * Keeps `dek` as the database key in place of a key that is lost or unreadable. Refuses any other
   * state: replacing a key that still works would make the database it protects unreadable. The caller
   * builds the new database with `dek` first, so a failed build never costs the old key. The old
   * Keystore key and file go before `dek` is stored, so a failure in between leaves no usable key:
   * the state reads as lost or fresh, never existing, and openHistory treats both as a lost key while
   * the database file exists.
   */
  fun replaceLostDatabaseKey(dek: ByteArray): Unit = synchronized(LOCK) {
    require(dek.size == DATABASE_KEY_BYTES) { "database key has the wrong length" }
    refuseUnless(keyState().replaceable) { "the database key is neither lost nor unreadable" }
    discardDatabaseKey()
    storeDatabaseKey(dek)
  }

  /**
   * Drops a lost or unreadable database key so the next `databaseKey()` mints a new one. Refuses
   * while a database file exists, which only the old key may open, and refuses a key that still
   * works or may work on a later read. A fresh state is accepted and only loses a stray `.new` file.
   * Throws when the Keystore key or its file survives, since the state would then not read fresh;
   * JS gets that as an unavailable key.
   */
  fun resetKeys(): Unit = synchronized(LOCK) {
    refuseUnless(DATABASE_FILES.none { File(sqliteDir, it).exists() }) { "a database file exists" }
    val state = keyState()
    refuseUnless(state.replaceable || state == KeyState.FRESH) {
      "the database key is in the existing state"
    }
    val dropFailure = discardDatabaseKey()
    if (presence() != KeyState.FRESH) {
      throw IllegalStateException("the old database key could not be dropped", dropFailure)
    }
  }

  // Returns the Keystore's failure instead of throwing: replaceLostDatabaseKey generates under the
  // same alias next, which replaces a surviving entry, and resetKeys checks that nothing is left
  // and attaches the failure to what it throws.
  private fun discardDatabaseKey(): Exception? {
    var failure: Exception? = null
    try {
      (deleteAlias ?: keyStore::deleteEntry)(KEK_ALIAS)
    } catch (e: Exception) {
      failure = e
    }
    databaseKeyFile.delete()
    File(databaseKeyFile.path + ".new").delete()
    return failure
  }

  /**
   * The staging Keystore entry, minted when the alias is absent. Unlike the database key, a lost one
   * is replaced: refusing would turn away every walk the watch hands over from now on. Items sealed
   * under the lost entry cannot be read under the new one; they stay on disk, the staging ones are
   * counted by `readStagedActivities` (outbox ones are not), and a replacement that finds a `.bin`
   * in `sealedDirs` logs a fixed line with no file name.
   */
  fun stagingKey(sealedDirs: List<File> = emptyList()): SecretKey = synchronized(LOCK) {
    existingKey(STAGING_ALIAS) ?: run {
      if (sealedDirs.any { dir -> dir.listFiles().orEmpty().any { it.name.endsWith(".bin") } }) {
        Log.w(TAG, "staging alias was missing; items staged before it cannot be read")
      }
      generateKey(STAGING_ALIAS)
    }
  }

  private fun createDatabaseKey(): ByteArray =
    ByteArray(DATABASE_KEY_BYTES).also {
      SecureRandom().nextBytes(it)
      storeDatabaseKey(it)
    }

  private fun storeDatabaseKey(dek: ByteArray) {
    val kek = generateKey(KEK_ALIAS)
    try {
      writeAtomically(KeyWrap(kek, KEK_ALIAS).wrap(dek))
    } catch (e: Exception) {
      // An alias without its file reads as a lost key; a failed write must not leave one behind.
      try {
        keyStore.deleteEntry(KEK_ALIAS)
      } catch (cleanup: Exception) {
        e.addSuppressed(cleanup)
      }
      throw e
    }
  }

  private fun writeAtomically(blob: ByteArray) {
    val dir = databaseKeyFile.parentFile!!
    // An IOException, not a check(): the key's state allowed the write, the disk did not.
    if (!dir.isDirectory && !dir.mkdirs()) throw IOException("cannot create the directory for the key")
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
    val kek = readKekOrLost { existingKey(KEK_ALIAS) }
    return unwrapDatabaseKey(kek, KEK_ALIAS, databaseKeyFile.readBytes())
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
    private const val TAG = "WatchLink"
    const val KEK_ALIAS = "crossfog.kek.v1"
    const val STAGING_ALIAS = "crossfog.staging.v1"
    const val DATABASE_KEY_BYTES = 32
    // The live file and the copy a restore keeps until the new one opens, matching
    // LIVE_DB and REPLACED_DB in src/backup/replace.ts. crossfog.restoring.db is left
    // out on purpose: a restore deletes and rebuilds it, and a half-built one protects nothing.
    private val DATABASE_FILES = listOf("crossfog.db", "crossfog.replaced.db")
  }
}

private inline fun refuseUnless(allowed: Boolean, message: () -> String) {
  if (!allowed) throw KeyRefusedException(message())
}

private val KeyState.replaceable get() = this == KeyState.LOST || this == KeyState.UNREADABLE

/**
 * The state of a key whose file and Keystore key are both present, from one `read` of it. Only a
 * failure for good is UNREADABLE and an alias with no Keystore key behind it LOST; anything that may
 * pass on a later read (a repeated UnrecoverableKeyException, a busy Keystore) stays EXISTING, so it
 * never lets the key be replaced.
 */
internal fun stateOfPresentKey(read: () -> Unit): KeyState =
  try {
    read()
    KeyState.EXISTING
  } catch (e: KeyLostException) {
    when {
      e.permanent -> KeyState.UNREADABLE
      e.absent -> KeyState.LOST
      else -> KeyState.EXISTING
    }
  } catch (e: Exception) {
    KeyState.EXISTING
  }

/**
 * The database key in `blob`, or a permanent KeyLostException when it can never unwrap under `kek`.
 * Only the failures caught below and the length check mean the key can never unwrap; anything else
 * (a busy Keystore) propagates because it may succeed on retry.
 */
internal fun unwrapDatabaseKey(kek: SecretKey, alias: String, blob: ByteArray): ByteArray {
  val dek = try {
    KeyWrap(kek, alias).unwrap(blob)
  } catch (e: AEADBadTagException) {
    throw KeyLostException("database key file does not match the Keystore key", e, permanent = true)
  } catch (e: KeyPermanentlyInvalidatedException) {
    throw KeyLostException("Keystore key was invalidated", e, permanent = true)
  }
  if (dek.size != Keys.DATABASE_KEY_BYTES) {
    dek.fill(0)
    throw KeyLostException("database key has the wrong length", permanent = true)
  }
  return dek
}

private const val KEK_RETRY_PAUSE_MS = 200L

/**
 * The key-encryption key `read` returns, or KeyLostException. UnrecoverableKeyException may also
 * be transient, so that failure is read once more after `pause` before it is reported as
 * KeyLostException. That exception is never permanent, so `keyState()` still reads EXISTING and
 * nothing replaces the key: replacing one that still works would make the database unreadable.
 * A null from `read` (an alias with no Keystore key behind it) is KeyLostException with `absent`
 * set, which `keyState()` reads as LOST.
 * Only `unwrapDatabaseKey` marks a failure permanent. Any other failure propagates unchanged; one
 * on the retry carries the first UnrecoverableKeyException as suppressed.
 */
internal fun readKekOrLost(
  pause: () -> Unit = { Thread.sleep(KEK_RETRY_PAUSE_MS) },
  read: () -> SecretKey?,
): SecretKey {
  val kek = try {
    read()
  } catch (first: UnrecoverableKeyException) {
    pause()
    try {
      read()
    } catch (e: UnrecoverableKeyException) {
      e.addSuppressed(first)
      throw KeyLostException("Keystore key cannot be used", e)
    } catch (e: Exception) {
      e.addSuppressed(first)
      throw e
    }
  }
  return kek ?: throw KeyLostException("Keystore key is missing", absent = true)
}
