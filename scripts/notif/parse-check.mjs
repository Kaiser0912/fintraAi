// Auto-log UPI payments: checks the notification parser on sample texts.
// Run: node scripts/notif/parse-check.mjs   (Node 23.6+ runs the .ts directly)
import { parseUpiNotification } from "../../src/lib/upiNotifications.ts"

const GPAY = "com.google.android.apps.nbu.paisa.user"
const PHONEPE = "com.phonepe.app"
const PAYTM = "net.one97.paytm"

// [pkg, title, text, expected amount (null = ignored), expected payee]
const cases = [
  [GPAY, "Payment successful", "₹150 paid to Riya Kumar", 150, "Riya Kumar"],
  [GPAY, "₹1 sent to Riya", "", 1, "Riya"],
  [GPAY, "You paid ₹240.50 to Sharma Kirana", "Paid via HDFC Bank 1234", 240.5, "Sharma Kirana"],
  [PHONEPE, "Paid ₹1,200 to Raj Electricals", "Payment successful", 1200, "Raj Electricals"],
  [PHONEPE, "Money sent successfully", "₹75 sent to amit.s@ybl", 75, null],
  [PAYTM, "Paid Rs.99 to Swiggy", "UPI Ref No 4321", 99, "Swiggy"],
  [PAYTM, "Rs 500 debited", "Paid to Chai Point via UPI", 500, "Chai Point"],
  ["com.android.shell", "Rs 150 paid to Riya", "smoke", 150, "Riya"],
  // ignored
  [GPAY, "You received ₹200", "Amit sent you money", null],
  [GPAY, "Riya requested ₹150", "Tap to pay", null],
  [PHONEPE, "Payment failed", "₹150 to Riya could not be completed", null],
  [GPAY, "You won ₹10 cashback", "Scratch card", null],
  [PAYTM, "Bill due", "Pay Rs 899 electricity bill", null],
  [PHONEPE, "Payment pending", "₹150 to Riya is processing", null],
  [GPAY, "Refund of ₹150", "credited to your account", null],
]

let fail = 0
for (const [pkg, title, text, amount, payee] of cases) {
  const r = parseUpiNotification({ id: "x", pkg, title, text, postedAt: 0 })
  const ok =
    amount == null ? r === null : r !== null && r.amount === amount && (payee === undefined || r.payee === payee)
  if (!ok) fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${title} | ${text}  →  ${JSON.stringify(r && { amount: r.amount, payee: r.payee, upiId: r.upiId })}`)
}
console.log(fail ? `\n${fail} failed` : "\nall passed")
process.exit(fail ? 1 : 0)
