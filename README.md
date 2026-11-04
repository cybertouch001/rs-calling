# R&S Calling

Telecaller call tracking and payout app: an admin web panel + an Android app for callers.

- **Admin (web, or the same Android app logged in as admin):** upload client numbers from Excel/CSV (duplicates removed),
  assign them to callers (by hand or shared equally / round-robin), add, edit, deactivate and remove callers, see and log out
  their devices.
- **Caller (Android):** assigned list, one-tap call, the app reads the phone's call log to verify each call placed from the app
  (number, start time, talk time, connected or not), result after each call (Interested / Not interested / Callback with date-time
  / Wrong number / Not reachable + note). Offline queue: calls are kept on the phone and synced later.
- **Payout:** ₹ per counted call and ₹ per Interested lead are set separately, plus the minimum duration for a call to count
  (default 30 s) and the repeat window (default 24 h). Daily / monthly totals per caller, adjustments with a reason,
  approve (locks the calls) and mark paid. Each call keeps the rates that were in force when it was made.
- **Anti-fraud:** only numbers on the caller's assigned list count; the call must be in the phone's call log with the same number
  and time; not connected / shorter than the minimum don't count; same-time (overlapping) calls don't count; repeat calls to the
  same number inside the window count once (any caller). Suspicious days are flagged (many very short calls, overlaps, calls to
  numbers not on the list, one number called many times, call-log mismatches). Every call shows counted / not counted + reason;
  the admin can override a call or reject a lead with a reason.
- Dashboard (today / 7 days / month), leads list with follow-up reminders and callbacks, Excel and PDF exports.
- **No call recording** in v1.0 (blocked on many Android 10+ phones, and consent matters).

## Layout

- `server/rules.js` — counting, anti-fraud and payout rules (pure functions, unit-tested)
- `server/worker.js` — API (Cloudflare Worker + D1). `server/config.js` is generated at build time (version, admin bootstrap
  password **hash**, APK name) and is committed empty.
- `site/` — landing / download page and the web app (`site/app/`, also bundled inside the APK)
- `android/` — Android shell (Java, no AndroidX): WebView with the bundled web app, call placing, call-log reading, file export
- `test/` — `rules.test.mjs` (node --test), `api.test.mjs` (API flow against a running server), Playwright scripts

## Build

```
npm i esbuild
node --test test/rules.test.mjs
RSC_BOOT=/path/to/admin-boot.json node build.mjs out /path/to/RS-Calling.apk   # admin-boot.json = {"username":"admin","pw":"pbkdf2-sha256$100000$<salt>$<hash>"}
rm -rf android/app/src/main/assets/app && mkdir -p android/app/src/main/assets && cp -r site/app android/app/src/main/assets/app
cd android && RSC_SIGNING_PROPS=/path/to/signing.properties ./gradlew assembleRelease
```

The signing key and admin password are kept outside this repository.

## Play Store

Apps that read the call log need Google's special permission approval (Call log permission declaration), so the APK is shared
by link from the website instead of the Play Store.

## v1.1.0 (4 Nov 2026)
- **Caller account** screen with wallet (earned / approved / pending / withdrawn / available), username, payment details (UPI or bank, validated, shown masked).
- **Withdrawals**: balance reserved while pending, 16-hour payout deadline (admin-editable), admin queue with overdue highlight, UPI QR + `upi://` link, mark paid (UTR) / reject (reason), Excel export. The app does not move money — the admin pays in their own UPI app.
- **Callback matching**: incoming/missed calls from numbers called through the app are recorded and attached to the client. Records only by default; an admin switch makes long incoming callbacks payable.
- **Auto-delete on the phone**: the app's own synced copies are removed after the retention period (default 7 days; admin setting). The phone's system call log is never touched.
- **Log requests**: a caller asks to see old logs with a purpose; the admin approves or rejects.
- **Admin log files**: daily and all-time, Excel and CSV, plus an automatic daily snapshot.
- **Terms & Conditions**: versioned, editable by the admin, acceptance gate for every caller (default text v1 in `server/rules.js`; not legal advice).
- **Help** chat: rule-based (no external AI), English + Hinglish keywords, refuses off-topic questions.
- **Streak**: computed on the server from counted calls per day; optional bonus at 7 / 30 days (0 by default).
- UI polish with the v1.0 colour palette unchanged.

Tests: `node --test test/rules.test.mjs test/rules11.test.mjs test/help.test.mjs` (unit), `test/api.test.mjs` + `test/api11.test.mjs` (API, against a local worker), `test/pw_admin1.py` + `test/pw_flow2.py` + `test/pw_v11.py` (Playwright with a simulated Android bridge), `test/live_test.py` (live, non-destructive).
The Android shell is unchanged apart from the version (1.1.0 / versionCode 110); it has **not** been run on a phone or emulator.
