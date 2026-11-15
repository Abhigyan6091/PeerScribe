package org.peerscribe.mobile

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class MainActivity : FlutterActivity() {
    companion object {
        private const val TAG = "PeerScribeBLE"
        private const val CHANNEL = "com.peerscribe.mesh/ble"
        private val CHARACTERISTIC_UUID: UUID = UUID.fromString("00005054-0000-1000-8000-00805F9B34FB")
    }

    private var methodChannel: MethodChannel? = null
    private var bluetoothManager: BluetoothManager? = null
    private var bluetoothAdapter: BluetoothAdapter? = null
    private var bluetoothLeAdvertiser: BluetoothLeAdvertiser? = null
    private var bluetoothLeScanner: BluetoothLeScanner? = null
    private var gattServer: BluetoothGattServer? = null

    private var isAdvertising = false
    private var isScanning = false
    private var currentPayload: String = ""
    private val mainHandler = Handler(Looper.getMainLooper())
    private val processedPeers = ConcurrentHashMap<String, Long>()

    private var advertiseCallback: AdvertiseCallback? = null
    private var scanCallback: ScanCallback? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        try {
            bluetoothManager = getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            bluetoothAdapter = bluetoothManager?.adapter
        } catch (e: Exception) {
            Log.w(TAG, "Bluetooth service unavailable: ${e.message}")
        }

        methodChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
        methodChannel?.setMethodCallHandler { call, result ->
            when (call.method) {
                "startAdvertising" -> {
                    val serviceUuidStr = call.argument<String>("serviceUuid") ?: "00005053-0000-1000-8000-00805F9B34FB"
                    val payload = call.argument<String>("payload") ?: "{}"
                    startBleAdvertising(serviceUuidStr, payload, result)
                }
                "updateBeaconPayload" -> {
                    val payload = call.argument<String>("payload") ?: "{}"
                    currentPayload = payload
                    result.success(true)
                }
                "stopAdvertising" -> {
                    stopBleAdvertising()
                    result.success(true)
                }
                "startScanning" -> {
                    val serviceUuidStr = call.argument<String>("serviceUuid") ?: "00005053-0000-1000-8000-00805F9B34FB"
                    startBleScanning(serviceUuidStr, result)
                }
                "stopScanning" -> {
                    stopBleScanning()
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun startBleAdvertising(serviceUuidStr: String, payload: String, result: MethodChannel.Result) {
        try {
            if (bluetoothAdapter == null || !bluetoothAdapter!!.isEnabled) {
                Log.w(TAG, "Bluetooth not enabled or not available for advertising.")
                result.success(false)
                return
            }

            currentPayload = payload
            val serviceUuid = UUID.fromString(serviceUuidStr)
            val pUuid = ParcelUuid(serviceUuid)

            // Setup local GATT Server to serve full payload if queried
            setupGattServer(serviceUuid)

            bluetoothLeAdvertiser = bluetoothAdapter?.bluetoothLeAdvertiser
            if (bluetoothLeAdvertiser == null) {
                Log.w(TAG, "Device does not support Bluetooth LE advertising.")
                result.success(false)
                return
            }

            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(true)
                .setTimeout(0)
                .build()

            val advDataBuilder = AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceUuid(pUuid)

            // Include compact payload in service data if within BLE advertising packet limits
            val payloadBytes = payload.toByteArray(StandardCharsets.UTF_8)
            if (payloadBytes.size <= 24) {
                advDataBuilder.addServiceData(pUuid, payloadBytes)
            }

            val scanResponseBuilder = AdvertiseData.Builder()
                .setIncludeTxPowerLevel(true)

            advertiseCallback = object : AdvertiseCallback() {
                override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
                    super.onStartSuccess(settingsInEffect)
                    isAdvertising = true
                    Log.i(TAG, "BLE advertising successfully started with service $serviceUuidStr")
                    mainHandler.post { result.success(true) }
                }

                override fun onStartFailure(errorCode: Int) {
                    super.onStartFailure(errorCode)
                    isAdvertising = false
                    Log.w(TAG, "BLE advertising failed with error code: $errorCode")
                    mainHandler.post { result.success(false) }
                }
            }

            bluetoothLeAdvertiser?.startAdvertising(settings, advDataBuilder.build(), scanResponseBuilder.build(), advertiseCallback)
        } catch (se: SecurityException) {
            Log.w(TAG, "Bluetooth permission not yet granted: ${se.message}")
            result.success(false)
        } catch (e: Exception) {
            Log.e(TAG, "Error starting BLE advertising: ${e.message}")
            result.success(false)
        }
    }

    private fun setupGattServer(serviceUuid: UUID) {
        try {
            if (gattServer != null) {
                gattServer?.close()
                gattServer = null
            }

            val gattServerCallback = object : BluetoothGattServerCallback() {
                override fun onCharacteristicReadRequest(
                    device: BluetoothDevice?,
                    requestId: Int,
                    offset: Int,
                    characteristic: BluetoothGattCharacteristic?
                ) {
                    super.onCharacteristicReadRequest(device, requestId, offset, characteristic)
                    if (characteristic?.uuid == CHARACTERISTIC_UUID) {
                        val fullBytes = currentPayload.toByteArray(StandardCharsets.UTF_8)
                        val responseBytes = if (offset < fullBytes.size) {
                            fullBytes.copyOfRange(offset, fullBytes.size)
                        } else {
                            ByteArray(0)
                        }
                        try {
                            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, responseBytes)
                        } catch (se: SecurityException) {
                            Log.w(TAG, "SecurityException in GATT sendResponse: ${se.message}")
                        }
                    }
                }
            }

            gattServer = bluetoothManager?.openGattServer(this, gattServerCallback)
            val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
            val characteristic = BluetoothGattCharacteristic(
                CHARACTERISTIC_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ
            )
            service.addCharacteristic(characteristic)
            gattServer?.addService(service)
        } catch (se: SecurityException) {
            Log.w(TAG, "SecurityException opening GATT server: ${se.message}")
        } catch (e: Exception) {
            Log.w(TAG, "Error setting up GATT server: ${e.message}")
        }
    }

    private fun stopBleAdvertising() {
        try {
            if (advertiseCallback != null && bluetoothLeAdvertiser != null) {
                bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
                advertiseCallback = null
            }
            gattServer?.close()
            gattServer = null
            isAdvertising = false
            Log.i(TAG, "BLE advertising stopped.")
        } catch (se: SecurityException) {
            Log.w(TAG, "SecurityException stopping advertising: ${se.message}")
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping advertising: ${e.message}")
        }
    }

    private fun startBleScanning(serviceUuidStr: String, result: MethodChannel.Result) {
        try {
            if (bluetoothAdapter == null || !bluetoothAdapter!!.isEnabled) {
                Log.w(TAG, "Bluetooth not enabled or not available for scanning.")
                result.success(false)
                return
            }

            bluetoothLeScanner = bluetoothAdapter?.bluetoothLeScanner
            if (bluetoothLeScanner == null) {
                Log.w(TAG, "BluetoothLeScanner not available.")
                result.success(false)
                return
            }

            val pUuid = ParcelUuid(UUID.fromString(serviceUuidStr))
            val filter = ScanFilter.Builder()
                .setServiceUuid(pUuid)
                .build()

            val scanSettings = ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build()

            scanCallback = object : ScanCallback() {
                override fun onScanResult(callbackType: Int, scanResult: ScanResult?) {
                    super.onScanResult(callbackType, scanResult)
                    if (scanResult == null) return

                    val record = scanResult.scanRecord ?: return
                    val device = scanResult.device
                    val address = device?.address ?: "UNKNOWN"

                    // Rate-limit processing per device to once every 4 seconds
                    val now = System.currentTimeMillis()
                    val lastSeen = processedPeers[address] ?: 0L
                    if (now - lastSeen < 4000L) return
                    processedPeers[address] = now

                    // 1. Check if payload was transmitted directly in service data
                    val sData = record.getServiceData(pUuid)
                    if (sData != null && sData.isNotEmpty()) {
                        val payloadStr = String(sData, StandardCharsets.UTF_8)
                        dispatchDiscoveredDevice(payloadStr, scanResult.rssi)
                        return
                    }

                    // 2. Otherwise connect via GATT to read the full beacon payload characteristic
                    connectAndReadPayload(device, scanResult.rssi)
                }

                override fun onScanFailed(errorCode: Int) {
                    super.onScanFailed(errorCode)
                    isScanning = false
                    Log.w(TAG, "BLE scan failed with error code: $errorCode")
                }
            }

            bluetoothLeScanner?.startScan(listOf(filter), scanSettings, scanCallback)
            isScanning = true
            Log.i(TAG, "BLE scanning started for service $serviceUuidStr")
            result.success(true)
        } catch (se: SecurityException) {
            Log.w(TAG, "Bluetooth scan permission not yet granted: ${se.message}")
            result.success(false)
        } catch (e: Exception) {
            Log.e(TAG, "Error starting BLE scan: ${e.message}")
            result.success(false)
        }
    }

    private fun connectAndReadPayload(device: BluetoothDevice, rssi: Int) {
        try {
            var gattClient: BluetoothGatt? = null
            val gattCallback = object : BluetoothGattCallback() {
                override fun onConnectionStateChange(gatt: BluetoothGatt?, status: Int, newState: Int) {
                    super.onConnectionStateChange(gatt, status, newState)
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        try {
                            gatt?.discoverServices()
                        } catch (se: SecurityException) {
                            gatt?.close()
                        }
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        try {
                            gatt?.close()
                        } catch (se: SecurityException) {}
                    }
                }

                override fun onServicesDiscovered(gatt: BluetoothGatt?, status: Int) {
                    super.onServicesDiscovered(gatt, status)
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        val characteristic = gatt?.services?.flatMap { it.characteristics }?.find { it.uuid == CHARACTERISTIC_UUID }
                        if (characteristic != null) {
                            try {
                                gatt.readCharacteristic(characteristic)
                            } catch (se: SecurityException) {
                                gatt.close()
                            }
                        } else {
                            gatt?.close()
                        }
                    } else {
                        gatt?.close()
                    }
                }

                override fun onCharacteristicRead(
                    gatt: BluetoothGatt?,
                    characteristic: BluetoothGattCharacteristic?,
                    status: Int
                ) {
                    super.onCharacteristicRead(gatt, characteristic, status)
                    if (status == BluetoothGatt.GATT_SUCCESS && characteristic?.value != null) {
                        val payloadStr = String(characteristic.value, StandardCharsets.UTF_8)
                        dispatchDiscoveredDevice(payloadStr, rssi)
                    }
                    try {
                        gatt?.close()
                    } catch (se: SecurityException) {}
                }
            }

            gattClient = device.connectGatt(this, false, gattCallback)
        } catch (se: SecurityException) {
            Log.w(TAG, "SecurityException connecting GATT to ${device.address}: ${se.message}")
        } catch (e: Exception) {
            Log.e(TAG, "Error reading GATT from ${device.address}: ${e.message}")
        }
    }

    private fun dispatchDiscoveredDevice(payload: String, rssi: Int) {
        mainHandler.post {
            try {
                methodChannel?.invokeMethod(
                    "onDeviceDiscovered",
                    mapOf("payload" to payload, "rssi" to rssi)
                )
            } catch (e: Exception) {
                Log.w(TAG, "Error notifying Flutter of discovered device: ${e.message}")
            }
        }
    }

    private fun stopBleScanning() {
        try {
            if (scanCallback != null && bluetoothLeScanner != null) {
                bluetoothLeScanner?.stopScan(scanCallback)
                scanCallback = null
            }
            isScanning = false
            processedPeers.clear()
            Log.i(TAG, "BLE scanning stopped.")
        } catch (se: SecurityException) {
            Log.w(TAG, "SecurityException stopping scan: ${se.message}")
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping scan: ${e.message}")
        }
    }

    override fun onDestroy() {
        stopBleAdvertising()
        stopBleScanning()
        super.onDestroy()
    }
}
