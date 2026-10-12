// RushPay BLE peripheral: makes the student laptop a real Bluetooth LE device ("RushPay-Student")
// that the vendor phone connects to with Web Bluetooth (Chrome on Android).
//
// GATT service (UUIDs must match lib/bleLink.ts):
//   ACK        write              vendor → student: PAYMENT_ACK JSON after verifying a scanned QR
//   TOKEN      read               student → vendor: current signed payment token (tap-free mode)
//   TOKEN_VER  read + notify      bumps whenever TOKEN changes, so the phone knows to re-read it
//
// Talks to ble-bridge/bridge.mjs over stdin/stdout, one JSON object per line:
//   stdin:  {"cmd":"token","token":"rp1...."}      stdout: {"event":"ack","data":"{...}"}
//           {"cmd":"debugAck","data":"{...}"}               {"event":"state"|"advertising"|"subscribed"|...}
//
// Build: npm run ble:build    (needs Xcode command line tools)

import CoreBluetooth
import Foundation

let serviceUUID = CBUUID(string: "B5E3F0A0-6D1C-4E8A-9A5E-7275736870A1")
let ackUUID = CBUUID(string: "B5E3F0A1-6D1C-4E8A-9A5E-7275736870A1")
let tokenUUID = CBUUID(string: "B5E3F0A2-6D1C-4E8A-9A5E-7275736870A1")
let tokenVersionUUID = CBUUID(string: "B5E3F0A3-6D1C-4E8A-9A5E-7275736870A1")
let localName = "RushPay"  // short: flags + 128-bit service UUID + name must fit the 31-byte advert

func emit(_ event: String, _ fields: [String: Any] = [:]) {
    var obj = fields
    obj["event"] = event
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

final class Peripheral: NSObject, CBPeripheralManagerDelegate {
    private var manager: CBPeripheralManager!
    private var versionCharacteristic: CBMutableCharacteristic?
    private var token = Data()
    private var tokenVersion: UInt32 = 0
    private var subscribers: [UUID: CBCentral] = [:]

    override init() {
        super.init()
        manager = CBPeripheralManager(delegate: self, queue: .main)
    }

    // MARK: Setup

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        let names: [CBManagerState: String] = [
            .poweredOn: "poweredOn", .poweredOff: "poweredOff", .unauthorized: "unauthorized",
            .unsupported: "unsupported", .resetting: "resetting", .unknown: "unknown",
        ]
        emit("state", ["state": names[peripheral.state] ?? "unknown"])
        guard peripheral.state == .poweredOn else { return }

        let ack = CBMutableCharacteristic(
            type: ackUUID, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeable])
        let tok = CBMutableCharacteristic(type: tokenUUID, properties: [.read], value: nil, permissions: [.readable])
        let ver = CBMutableCharacteristic(
            type: tokenVersionUUID, properties: [.read, .notify], value: nil, permissions: [.readable])
        versionCharacteristic = ver

        let service = CBMutableService(type: serviceUUID, primary: true)
        service.characteristics = [ack, tok, ver]
        peripheral.removeAllServices()
        peripheral.add(service)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error {
            emit("error", ["message": "add service: \(error.localizedDescription)"])
            return
        }
        peripheral.startAdvertising([
            CBAdvertisementDataLocalNameKey: localName,
            CBAdvertisementDataServiceUUIDsKey: [serviceUUID],
        ])
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error {
            emit("error", ["message": "advertise: \(error.localizedDescription)"])
        } else {
            emit("advertising", ["name": localName, "service": serviceUUID.uuidString.lowercased()])
        }
    }

    // MARK: Connections (a peripheral only learns about centrals when they subscribe)

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                           didSubscribeTo characteristic: CBCharacteristic) {
        subscribers[central.identifier] = central
        emit("subscribed", ["central": central.identifier.uuidString, "mtu": central.maximumUpdateValueLength,
                            "count": subscribers.count])
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                           didUnsubscribeFrom characteristic: CBCharacteristic) {
        subscribers.removeValue(forKey: central.identifier)
        emit("unsubscribed", ["central": central.identifier.uuidString, "count": subscribers.count])
    }

    // MARK: Reads (long reads arrive with an offset)

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        let value: Data
        switch request.characteristic.uuid {
        case tokenUUID: value = token
        case tokenVersionUUID: value = versionBytes()
        default:
            peripheral.respond(to: request, withResult: .requestNotSupported)
            return
        }
        guard request.offset <= value.count else {
            peripheral.respond(to: request, withResult: .invalidOffset)
            return
        }
        request.value = value.subdata(in: request.offset..<value.count)
        peripheral.respond(to: request, withResult: .success)
    }

    // MARK: Writes (a long write arrives as several requests with offsets, all in one callback)

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        var buffer = Data()
        for request in requests where request.characteristic.uuid == ackUUID {
            guard let chunk = request.value else { continue }
            if request.offset == 0 { buffer = chunk } else { buffer.append(chunk) }
        }
        if let first = requests.first { peripheral.respond(to: first, withResult: .success) }
        if !buffer.isEmpty, let text = String(data: buffer, encoding: .utf8) {
            emit("ack", ["data": text])
        }
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        notifyVersion()
    }

    // MARK: Commands from bridge.mjs

    func setToken(_ value: String) {
        token = Data(value.utf8)
        tokenVersion &+= 1
        notifyVersion()
        emit("tokenSet", ["version": tokenVersion, "bytes": token.count])
    }

    private func versionBytes() -> Data {
        withUnsafeBytes(of: tokenVersion.littleEndian) { Data($0) }
    }

    private func notifyVersion() {
        guard let ver = versionCharacteristic, !subscribers.isEmpty else { return }
        _ = manager.updateValue(versionBytes(), for: ver, onSubscribedCentrals: nil)
    }
}

let peripheral = Peripheral()

// Read newline-delimited JSON commands from stdin.
var stdinBuffer = Data()
FileHandle.standardInput.readabilityHandler = { handle in
    let chunk = handle.availableData
    if chunk.isEmpty {
        exit(0)  // bridge closed our stdin: shut down
    }
    DispatchQueue.main.async {
        stdinBuffer.append(chunk)
        while let nl = stdinBuffer.firstIndex(of: 0x0A) {
            let line = stdinBuffer.subdata(in: stdinBuffer.startIndex..<nl)
            stdinBuffer.removeSubrange(stdinBuffer.startIndex...nl)
            guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let cmd = obj["cmd"] as? String else { continue }
            switch cmd {
            case "token":
                if let t = obj["token"] as? String { peripheral.setToken(t) }
            case "debugAck":
                if let d = obj["data"] as? String { emit("ack", ["data": d]) }
            default:
                emit("error", ["message": "unknown command \(cmd)"])
            }
        }
    }
}

emit("starting", ["name": localName])
RunLoop.main.run()
