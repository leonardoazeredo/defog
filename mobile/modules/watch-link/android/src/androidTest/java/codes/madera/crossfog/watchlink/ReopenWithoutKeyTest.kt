package codes.madera.crossfog.watchlink

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import net.zetetic.database.sqlcipher.SQLiteDatabase as CipherDatabase
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

// A SQLCipher file must be unreadable as plain SQLite and under a different key. Uses a fixed test key, not the device key.
@RunWith(AndroidJUnit4::class)
class ReopenWithoutKeyTest {
  private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
  private val file: File = context.getDatabasePath("crossfog-reopen.db")
  private val key = ByteArray(32) { it.toByte() }

  @Before
  fun start() {
    // The SQLCipher AAR does not load libsqlcipher.so itself, so load it before the first cipher open.
    System.loadLibrary("sqlcipher")
    file.parentFile?.mkdirs()
    file.delete()
    writeUnderKey()
  }

  @After
  fun finish() {
    file.delete()
  }

  private fun writeUnderKey() {
    val db = CipherDatabase.openOrCreateDatabase(file.path, key, null, null, null)
    db.beginTransaction()
    db.execSQL("CREATE TABLE t (v INTEGER)")
    db.execSQL("INSERT INTO t VALUES (1)")
    db.setTransactionSuccessful()
    db.endTransaction()
    db.close()
  }

  @Test
  fun theHeaderIsNotThePlainSqliteOne() {
    val head = file.inputStream().use { s -> ByteArray(16).also { s.read(it) } }
    assertTrue(!String(head, Charsets.ISO_8859_1).startsWith("SQLite format 3"))
  }

  @Test
  fun plainSqliteWithNoKeyCannotRead() {
    val e = assertThrows(SQLiteException::class.java) {
      SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use {
        it.rawQuery("SELECT count(*) FROM sqlite_master", null).use { c -> c.moveToFirst() }
      }
    }
    // Android's SQLite words an encrypted file this way; a platform that rewords it needs this line updated.
    assertTrue(e.message.orEmpty(), e.message.orEmpty().contains("file is not a database"))
  }

  @Test
  fun sqlcipherWithAWrongKeyCannotRead() {
    val wrong = ByteArray(32) { 0x55 }
    assertThrows(Exception::class.java) {
      CipherDatabase.openOrCreateDatabase(file.path, wrong, null, null, null).use {
        it.rawQuery("SELECT count(*) FROM sqlite_master", emptyArray<String>()).use { c -> c.moveToFirst() }
      }
    }
  }

  @Test
  fun theRightKeyStillReads() {
    CipherDatabase.openOrCreateDatabase(file.path, key, null, null, null).use { db ->
      db.rawQuery("SELECT v FROM t", emptyArray<String>()).use { c ->
        assertTrue(c.moveToFirst())
        assertEquals(1, c.getInt(0))
      }
    }
  }
}
