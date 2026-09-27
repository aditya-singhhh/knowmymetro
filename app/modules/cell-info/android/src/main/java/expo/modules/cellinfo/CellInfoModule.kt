package expo.modules.cellinfo

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.CellIdentityNr
import android.telephony.CellInfo
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoWcdma
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

/**
 * Reads the mobile towers the phone can see (serving and neighbouring cells).
 * Used by the trip recorder to learn which towers belong to which stretch of the metro,
 * so positions can later be estimated without GPS. No network or GPS is used here.
 */
class CellInfoModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private val executor = Executors.newSingleThreadExecutor()

  override fun definition() = ModuleDefinition {
    Name("CellInfo")

    AsyncFunction("getCellsAsync") { promise: Promise ->
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
        promise.resolve(emptyList<Map<String, Any?>>())
        return@AsyncFunction
      }
      val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
      if (tm == null) {
        promise.resolve(emptyList<Map<String, Any?>>())
        return@AsyncFunction
      }
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          // Ask the modem for fresh readings; fall back to the cached list if it refuses.
          tm.requestCellInfoUpdate(executor, object : TelephonyManager.CellInfoCallback() {
            override fun onCellInfo(cells: MutableList<CellInfo>) {
              promise.resolve(cells.mapNotNull(::describe))
            }
            override fun onError(errorCode: Int, detail: Throwable?) {
              promise.resolve(cached(tm))
            }
          })
        } else {
          promise.resolve(cached(tm))
        }
      } catch (e: SecurityException) {
        promise.resolve(emptyList<Map<String, Any?>>())
      }
    }
  }

  private fun cached(tm: TelephonyManager): List<Map<String, Any?>> =
    try { tm.allCellInfo?.mapNotNull(::describe) ?: emptyList() } catch (e: SecurityException) { emptyList() }

  // mcc/mnc strings exist on each cell type from Android 9 (API 28); the base CellIdentity doesn't expose them
  private fun mcc(id: android.telephony.CellIdentity): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
    return when (id) {
      is android.telephony.CellIdentityLte -> id.mccString
      is android.telephony.CellIdentityWcdma -> id.mccString
      is android.telephony.CellIdentityGsm -> id.mccString
      else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && id is android.telephony.CellIdentityNr) id.mccString else null
    }
  }
  private fun mnc(id: android.telephony.CellIdentity): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
    return when (id) {
      is android.telephony.CellIdentityLte -> id.mncString
      is android.telephony.CellIdentityWcdma -> id.mncString
      is android.telephony.CellIdentityGsm -> id.mncString
      else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && id is android.telephony.CellIdentityNr) id.mncString else null
    }
  }

  private fun ok(v: Int): Int? = if (v == Int.MAX_VALUE || v == CellInfo.UNAVAILABLE) null else v
  private fun okL(v: Long): Long? = if (v == Long.MAX_VALUE) null else v

  private fun describe(cell: CellInfo): Map<String, Any?>? {
    val base = mutableMapOf<String, Any?>("reg" to cell.isRegistered)
    when {
      cell is CellInfoLte -> {
        val id = cell.cellIdentity
        base += mapOf("type" to "lte", "ci" to ok(id.ci), "tac" to ok(id.tac), "pci" to ok(id.pci), "arfcn" to ok(id.earfcn),
          "mcc" to mcc(id), "mnc" to mnc(id), "dbm" to ok(cell.cellSignalStrength.dbm))
      }
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && cell is CellInfoNr -> {
        val id = cell.cellIdentity as CellIdentityNr
        base += mapOf("type" to "nr", "ci" to okL(id.nci), "tac" to ok(id.tac), "pci" to ok(id.pci), "arfcn" to ok(id.nrarfcn),
          "mcc" to mcc(id), "mnc" to mnc(id), "dbm" to ok(cell.cellSignalStrength.dbm))
      }
      cell is CellInfoWcdma -> {
        val id = cell.cellIdentity
        base += mapOf("type" to "wcdma", "ci" to ok(id.cid), "tac" to ok(id.lac), "pci" to ok(id.psc), "arfcn" to ok(id.uarfcn),
          "mcc" to mcc(id), "mnc" to mnc(id), "dbm" to ok(cell.cellSignalStrength.dbm))
      }
      cell is CellInfoGsm -> {
        val id = cell.cellIdentity
        base += mapOf("type" to "gsm", "ci" to ok(id.cid), "tac" to ok(id.lac), "pci" to ok(id.bsic), "arfcn" to ok(id.arfcn),
          "mcc" to mcc(id), "mnc" to mnc(id), "dbm" to ok(cell.cellSignalStrength.dbm))
      }
      else -> return null
    }
    return base
  }
}
