// Auto-log UPI payments: checks the notification parser on sample texts.
// Run: node scripts/notif/parse-check.mjs   (Node 23.6+ runs the .ts directly)
import { collapseDuplicates, parseUpiNotification } from "../../src/lib/upiNotifications.ts"

const GPAY = "com.google.android.apps.nbu.paisa.user"
const PHONEPE = "com.phonepe.app"
const PAYTM = "net.one97.paytm"
const SMS = "com.google.android.apps.messaging"

// [pkg, title, text, expected amount (null = ignored), expected payee, expected upiId]
const cases = [
  // UPI app notifications
  [GPAY, "Payment successful", "₹150 paid to Riya Kumar", 150, "Riya Kumar"],
  [GPAY, "₹1 sent to Riya", "", 1, "Riya"],
  [GPAY, "You paid ₹240.50 to Sharma Kirana", "Paid via HDFC Bank 1234", 240.5, "Sharma Kirana"],
  [PHONEPE, "Paid ₹1,200 to Raj Electricals", "Payment successful", 1200, "Raj Electricals"],
  [PHONEPE, "Money sent successfully", "₹75 sent to amit.s@ybl", 75, null, "amit.s@ybl"],
  [PAYTM, "Paid Rs.99 to Swiggy", "UPI Ref No 4321", 99, "Swiggy"],
  [PAYTM, "Rs 500 debited", "Paid to Chai Point via UPI", 500, "Chai Point"],
  ["com.android.shell", "Rs 150 paid to Riya", "smoke", 150, "Riya"],
  // Bank SMS (title = sender as the SMS app shows it)
  [SMS, "AX-SBIUPI", "Dear UPI user A/C X1234 debited by 1.0 on date 27Nov26 trf to RIYA KUMAR Refno 432112345678. If not u? call 1800111109. -SBI", 1, "Riya Kumar"],
  [SMS, "VM-HDFCBK", "Sent Rs.1.00\nFrom HDFC Bank A/C *1234\nTo RIYA KUMAR\nOn 27/11/26\nRef 432112345678\nNot You?\nCall 18002586161/SMS BLOCK UPI to 7308080808", 1, "Riya Kumar"],
  [SMS, "JD-ICICIT", "ICICI Bank Acct XX123 debited for Rs 240.00 on 27-Nov-26; SHARMA KIRANA credited. UPI:432112345678. Call 18002662 for dispute. SMS BLOCK 123 to 9215676766.", 240, "Sharma Kirana"],
  [SMS, "AD-AXISBK", "INR 150.00 debited\nA/c no. XX1234\n27-11-26, 10:15:00\nUPI/P2P/432112345678/RIYA KUMAR\nNot you? SMS BLOCKUPI Cust ID to 919951860002\nAxis Bank", 150, "Riya Kumar"],
  [SMS, "BP-KOTAKB", "Sent Rs.75.00 from Kotak Bank AC X1234 to amit.s@ybl on 27-11-26.UPI Ref 432112345678. Not you, https://kotak.com/KBANKT/Fraud", 75, null, "amit.s@ybl"],
  [SMS, "VK-PNBSMS", "Rs.1.00 debited from A/c XX1234 on 27-11-26 to VPA riya.k@oksbi (UPI Ref No 432112345678). Not you? Call 18001802222", 1, null, "riya.k@oksbi"],
  [SMS, "AX-HDFCBK", "Rs 500.00 spent on HDFC Bank Card x1234 at AMAZON on 2026-11-27:10:15:00. Avl Limit: INR 49,500.00. Not you? Call 18002586161", 500, "Amazon"],
  [SMS, "JM-BOIIND", "Rs.60.00 debited A/cXX1234 and credited to CHAI POINT via UPI Ref No 432112345678 on 27Nov26. Call 18001031906, if not done by you. -BOI", 60, "Chai Point"],
  // ignored
  [GPAY, "You received ₹200", "Amit sent you money", null],
  [GPAY, "Riya requested ₹150", "Tap to pay", null],
  [PHONEPE, "Payment failed", "₹150 to Riya could not be completed", null],
  [GPAY, "You won ₹10 cashback", "Scratch card", null],
  [PAYTM, "Bill due", "Pay Rs 899 electricity bill", null],
  [PHONEPE, "Payment pending", "₹150 to Riya is processing", null],
  [GPAY, "Refund of ₹150", "credited to your account", null],
  [SMS, "AX-SBIUPI", "Dear SBI User, your A/c X1234-credited by Rs.200 on 27Nov26 transfer from AMIT Ref No 432112345678 -SBI", null],
  [SMS, "VM-HDFCBK", "123456 is the OTP for txn of INR 500.00 at AMAZON on HDFC Bank card ending 1234. Valid till 10:20. Do not share OTP", null],
  [SMS, "AD-AIRTEL", "Your Airtel bill of Rs 499 is due on 30-Nov. Pay now", null],
  [SMS, "JD-ICICIT", "Your A/c XX123 will be debited for Rs 199 on 28-Nov towards Netflix mandate", null],
]

let fail = 0
for (const [pkg, title, text, amount, payee, upiId] of cases) {
  const kind = pkg === SMS ? "sms" : "app"
  const r = parseUpiNotification({ id: "x", pkg, kind, title, text, postedAt: 0 })
  const ok =
    amount == null
      ? r === null
      : r !== null &&
        r.amount === amount &&
        (payee === undefined || r.payee === payee) &&
        (upiId === undefined || r.upiId === upiId)
  if (!ok) fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${clip(title)} | ${clip(text)}  →  ${JSON.stringify(r && { amount: r.amount, payee: r.payee, upiId: r.upiId })}`)
}

// GPay notification + bank SMS for one payment → one prompt, with the name.
const merged = collapseDuplicates([
  { id: "a", amount: 1, payee: null, upiId: "riya.k@oksbi", app: "Bank SMS", postedAt: 1000 },
  { id: "b", amount: 1, payee: "Riya", upiId: null, app: "Google Pay", postedAt: 30_000 },
  { id: "c", amount: 1, payee: "Riya", upiId: null, app: "Google Pay", postedAt: 20 * 60_000 },
])
const okMerge = merged.length === 2 && merged[0].ids.length === 2 && merged[0].notice.payee === "Riya" && merged[0].notice.upiId === "riya.k@oksbi"
if (!okMerge) fail++
console.log(`${okMerge ? "PASS" : "FAIL"}  duplicates collapse  →  ${JSON.stringify(merged.map((g) => ({ ids: g.ids, payee: g.notice.payee, upi: g.notice.upiId })))}`)

console.log(fail ? `\n${fail} failed` : "\nall passed")
process.exit(fail ? 1 : 0)

function clip(s) {
  s = s.replace(/\n/g, " ")
  return s.length > 60 ? s.slice(0, 57) + "…" : s
}
