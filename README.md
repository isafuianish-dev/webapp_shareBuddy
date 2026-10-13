# Share Buddy

Send files between two devices on the same network, straight from the browser. Files travel
directly from one device to the other over WebRTC — they are never uploaded anywhere.

## How to use it

Open Share Buddy on both devices.

1. **Sending device:** choose or drop your files, then click **Get code**. A 6-digit code appears.
2. **Receiving device:** type the code into **Receive** and click **Join**.
3. **Sending device:** click **Allow** when it asks whether the connecting device is yours.
4. Files start sending. On the receiving device, click **Save** (or **Save all**) as they arrive.

You can add more files on the sender at any time while connected. **Start over** resets both panes.

## How the 6-digit code works

Two browsers cannot find each other on their own, so Share Buddy uses the free public
[PeerJS](https://peerjs.com) broker as an introduction service: the code is registered there as
`sharebuddy-123456`, and the receiving device looks it up. The broker only passes the small
connection handshake; **file data never goes through it**. Once the devices are connected the
sender drops off the broker, so the code stops working.

- The code only lets a device *ask* to connect. The sender must click **Allow**, so a guessed
  code alone can't pull files.
- The connection uses a Google STUN server to discover network addresses. There is no relay
  (TURN) server, so file data never travels through a third party.
- Requires an internet connection for the pairing step (the broker is a hosted service — if it
  is down, pairing fails).
- PeerJS (v1.5.4, MIT) is bundled as `peerjs.min.js`; see `peerjs.LICENSE.txt`.

## Limits and troubleshooting

- **Same network.** Guest Wi-Fi and some routers stop devices from reaching each other, which
  blocks the connection. Browsers also hide local addresses behind `.local` names that need
  multicast DNS to resolve; a network that blocks it can prevent connecting.
- **File size.** The receiving browser holds the whole file in memory until you save it, so
  very large files (multiple GB, or several hundred MB on phones) may fail.
- **Keep both tabs open** and awake during a transfer; closing either ends it.
- Files are encrypted in transit (DTLS). There is no account and no analytics.
