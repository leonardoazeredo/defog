package codes.madera.crossfog.watchlink

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import java.io.Serializable

data class CreateInput(val name: String, val mime: String) : Serializable

/** The system "save as" picker; the result is the new document's URI, or null when the user backs out. */
class CreateDocumentContract : AppContextActivityResultContract<CreateInput, Uri?> {
  override fun createIntent(context: Context, input: CreateInput) =
    Intent(Intent.ACTION_CREATE_DOCUMENT)
      .addCategory(Intent.CATEGORY_OPENABLE)
      .setType(input.mime)
      .putExtra(Intent.EXTRA_TITLE, input.name)

  override fun parseResult(input: CreateInput, resultCode: Int, intent: Intent?): Uri? =
    if (resultCode == Activity.RESULT_OK) intent?.data else null
}
