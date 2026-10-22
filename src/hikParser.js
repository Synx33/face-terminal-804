// Normalizes an AcsEvent search-result record (ISAPI
// AccessControl/AcsEvent) into the flat shape our db/dashboard use.
//
// On the DS-K1T343EWX (the device this file was originally written
// against), a non-identification event (door status, tamper, etc.) simply
// omits `name`/`employeeNoString` entirely -- their absence was the signal
// isCheckin() used.
//
// Confirmed live against a real DS-K1T804BEF (scripts/probe-device.js) that
// this device does NOT work the same way: every one of 3 real non-
// identification events (door-status/operation entries, none with a name,
// cardNo, or real person attached) still carried `employeeNoString: "0"` --
// the literal STRING "0", not an absent/null field. "0" is JS-truthy, so
// the original `Boolean(parsed.employeeNo)` check would have wrongly
// treated every one of these as a real check-in and created a bogus
// attendance row for a nonexistent "employee #0" on every door event this
// device logs. isCheckin() below explicitly excludes "0" for exactly this
// reason -- this is a DS-K1T804-specific fix, not backported to the
// original DS-K1T343EWX codebase since there's no evidence that device
// shares this sentinel-value convention.
//
// We use AcsEvent search exclusively (polling — see poller.js) rather than
// the device's httpHosts push mechanism: arming push notifications flooded
// us with an unrelated historical backlog instead of real-time events
// (confirmed on the 343EWX; not yet re-verified on this device, but the
// same polling approach is used regardless).

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function deepFind(obj, key) {
  if (obj == null || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = deepFind(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Tries each key in order and returns the first present value. Kept generic
// (rather than one fixed field name) because this device has already shown
// two different names for the same field across contexts — e.g.
// employeeNoString vs. employeeNo — so a bit of alias tolerance here is
// cheap insurance, not speculative generality.
function firstOf(doc, keys) {
  for (const key of keys) {
    const v = deepFind(doc, key);
    if (v !== undefined && v !== null) return String(v);
  }
  return null;
}

function parseJsonEvent(doc) {
  return {
    eventTime: firstOf(doc, ['time']),
    deviceIp: firstOf(doc, ['ipAddress']),
    deviceSerial: firstOf(doc, ['deviceID', 'macAddress']),
    majorEvent: toInt(firstOf(doc, ['major'])),
    minorEvent: toInt(firstOf(doc, ['minor'])),
    verifyMode: firstOf(doc, ['currentVerifyMode']),
    doorNo: toInt(firstOf(doc, ['doorNo'])),
    readerNo: toInt(firstOf(doc, ['cardReaderNo'])),
    employeeNo: firstOf(doc, ['employeeNoString', 'employeeNo']),
    name: firstOf(doc, ['name']),
    cardNo: firstOf(doc, ['cardNo']),
    serialNo: toInt(firstOf(doc, ['serialNo'])),
    raw: JSON.stringify(doc),
  };
}

// A bare cardNo counts too, alongside name/employeeNo — added for the
// DS-K2802 card-reader controller, where the device itself may or may not
// resolve the swipe to an employeeNo the same reliable way the face
// terminal's own UserInfo lookup does (unverified until tested against real
// hardware — see scripts/diagnose-card-device.js). Treating any of the three
// as "an identification was attempted" lets db.js's insertCheckin() resolve
// the person locally via its own card_no mapping even if the device didn't,
// rather than silently dropping the event here before it ever gets a chance to.
//
// employeeNo === '0' is deliberately excluded -- see this file's header
// comment. A real employeeNo on this device's own UserInfo enrollment is a
// small positive integer string ("1", "2", ...); "0" is the device's own
// sentinel for "nobody", confirmed against real non-identification events.
/** True if this event represents an identified person (a check-in), not a bare door/tamper event. */
function isCheckin(parsed) {
  const hasRealEmployeeNo = Boolean(parsed.employeeNo) && parsed.employeeNo !== '0';
  return Boolean(parsed.name || hasRealEmployeeNo || parsed.cardNo);
}

module.exports = { parseJsonEvent, isCheckin };
