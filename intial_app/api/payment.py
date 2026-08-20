import frappe
import requests
from frappe import _
from frappe.utils import flt, cint, now, today
from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

MIDDLEWARE_URL = "http://middleware_site:8000/api/method/middleware_app.api.payment"


@frappe.whitelist(allow_guest=True)

def request_otp(mobile):

    if not mobile:
        frappe.throw(_("Mobile number is required."))

    response = requests.post(f"{MIDDLEWARE_URL}.request_otp", json={"mobile": mobile}, timeout=20)

    if response.status_code != 200:
        frappe.throw(_("Middleware Request Error: {0}").format(response.text))

    return response.json().get("message")





@frappe.whitelist(allow_guest=True)
def verify_otp(otp_verification_id, otp, invoice_id, mobile=None, receiver_bank_account=None, mode_of_payment=None, sender_account=None):

    if not otp_verification_id or not otp or not invoice_id:

        frappe.throw(_("Verification ID, OTP, and Invoice ID are mandatory."))



    invoice = frappe.get_doc("Purchase Invoice", invoice_id)
    existing_numbers = [cint(row.installation_no or 0) for row in invoice.get("custom_install", [])]
    next_install_no = max([0] + existing_numbers) + 1



    payload = {
        "otp_verification_id": otp_verification_id,
        "otp": otp,
        "invoice_id": invoice_id,
        "mobile": mobile,
        "install_no": next_install_no,
        "receiver_bank_account": receiver_bank_account,
        "mode_of_payment": mode_of_payment,
        "sender_account": sender_account
    }

    response = requests.post(f"{MIDDLEWARE_URL}.verify_otp", json=payload, timeout=20)
    if response.status_code != 200:
        frappe.throw(_("Middleware Verification Error: {0}").format(response.text))

    return response.json().get("message")





@frappe.whitelist(allow_guest=True)
def save_otp_failure(invoice_id, ref_no, error, otp_entered, mobile, attempt_no):

    if not invoice_id:
        frappe.throw(_("Purchase Invoice is required."))

    invoice = frappe.get_doc("Purchase Invoice", invoice_id)
    row = invoice.append("custom_error_log", {})
    row.ref_no = ref_no
    row.error = error
    row.otp_entered = otp_entered
    row.time = now()
    row.mobile = mobile


    if hasattr(row, "attempt_no"):
        row.attempt_no = attempt_no

    invoice.save(ignore_permissions=True)
    return {"success": True, "message": "OTP failure recorded."}




@frappe.whitelist(allow_guest=True)
def create_processing_payment(invoice_id, amount, mobile, transaction_id, sender_account=None, mode_of_payment=None, otp_verification_id=None):

    amount = flt(amount)
    if amount <= 0:
        frappe.throw(_("Payment amount must be greater than zero."))


    invoice = frappe.get_doc("Purchase Invoice", invoice_id)
    for row in invoice.get("custom_install", []):
        if row.payment_status in ("Pending", "Processing"):
            frappe.throw(_("A payment is already Pending or Processing."))



    existing_numbers = [cint(row.installation_no or 0) for row in invoice.get("custom_install", [])]
    next_no = max([0] + existing_numbers) + 1



    row = invoice.append("custom_install", {})
    row.installation_no = next_no
    row.ref_no = otp_verification_id
    row.amount = amount
    row.mobile = mobile
    row.transaction_id = transaction_id
    row.otp_status = "Verified"
    row.payment_status = "Pending"

    invoice.save(ignore_permissions=True)
    return {
        "success": True,
        "installation_no": next_no,
        "ref_no": otp_verification_id,
        "transaction_id": transaction_id,
        "payment_status": "Pending"
    }


@frappe.whitelist(allow_guest=True)
def process_payment(transaction_id, amount, invoice_id, mobile, receiver_bank_account, mode_of_payment, sender_account, install_no=None):


    print("THIS IS FROM PROCESS CODE")
    if not sender_account or not receiver_bank_account:
        frappe.throw(_("Sender and Receiver Bank Accounts are required."))


    bank_account_doc = frappe.get_doc("Bank Account", receiver_bank_account)
    receiver_account_no = bank_account_doc.bank_account_no


    if not receiver_account_no:
        frappe.throw(_("Bank Account '{0}' has no Bank Account Number.").format(receiver_bank_account))


    payload = {
        "transaction_id": transaction_id,
        "amount": flt(amount),
        "invoice_id": invoice_id,
        "mobile": mobile,
        "receiver_bank_account": receiver_bank_account,
        "receiver_account_number": receiver_account_no,
        "mode_of_payment": mode_of_payment,
        "sender_account": sender_account,
        "install_no": install_no
    }
   
    response = requests.post(f"{MIDDLEWARE_URL}.process_payment", json=payload, timeout=300)
    if response.status_code != 200:
        frappe.throw(_("Middleware Processing Error: {0}").format(response.text))
    return response.json().get("message")




@frappe.whitelist(allow_guest=True)
def save_payment_result(invoice_id, transaction_id, amount, mobile, status, bank_reference=None, failure_reason=None, sender_account=None, mode_of_payment=None):

    invoice = frappe.get_doc("Purchase Invoice", invoice_id)
    row = next((r for r in invoice.get("custom_install", []) if r.transaction_id == transaction_id), None)

    if not row:
        frappe.throw(_("Installation record not found for transaction {0}.").format(transaction_id))

    row.amount = flt(amount)
    row.mobile = mobile
    status_upper = str(status).upper()

    print("THIS IS FROM ERP STATYS",status)

    if status_upper == "SUCCESS":
        row.payment_status = "Success"
        row.bank_reference = bank_reference
        row.failure_reason = None
        row.paid_at = now()
        invoice.save(ignore_permissions=True)

        payment_entry_name = create_payment_entry_for_invoice(
            invoice_id=invoice_id,
            transaction_id=transaction_id,
            amount=flt(amount),
            sender_account=sender_account,
            mode_of_payment=mode_of_payment,
            bank_reference=bank_reference
        )

        row.db_set("payment_entry", payment_entry_name)
        return {
            "success": True,
            "installation_no": row.installation_no,
            "ref_no": row.ref_no,
            "transaction_id": transaction_id,
            "payment_status": "Success",
            "bank_reference": bank_reference,
            "payment_entry": payment_entry_name
        }

    elif status_upper == "PENDING":
        row.payment_status = "Pending"
        row.bank_reference = bank_reference
        row.failure_reason = None
        invoice.save(ignore_permissions=True)
        return {
            "success": True,
            "installation_no": row.installation_no,
            "ref_no": row.ref_no,
            "transaction_id": transaction_id,
            "payment_status": "Pending"
        }
    
    elif status_upper == "REJECTED":
            row.payment_status = "Failed"
            row.bank_reference = bank_reference
            row.failure_reason = failure_reason or "Payment failed."
            invoice.save(ignore_permissions=True)
            return {
                "success": True,
                "installation_no": row.installation_no,
                "ref_no": row.ref_no,
                "transaction_id": transaction_id,
                "payment_status": "Pending"
            }

    else:
        row.payment_status = "Failed"
        row.failure_reason = failure_reason or "Payment failed."
        row.bank_reference = bank_reference
        invoice.save(ignore_permissions=True)
        return {
            "success": True,
            "installation_no": row.installation_no,
            "ref_no": row.ref_no,
            "transaction_id": transaction_id,
            "payment_status": "Failed",
            "failure_reason": row.failure_reason
        }


def create_payment_entry_for_invoice(invoice_id, transaction_id, amount, sender_account, mode_of_payment=None, bank_reference=None):
    invoice = frappe.get_doc("Purchase Invoice", invoice_id)
    if invoice.docstatus != 1:
        frappe.throw(_("Purchase Invoice must be submitted to generate Payment Entry."))

    bank_account_doc = frappe.get_doc("Bank Account", sender_account)
    bank_gl_account = bank_account_doc.account

    existing_entry = frappe.db.get_value("Payment Entry", {"custom_transaction_id": transaction_id}, "name")
    if existing_entry:
        return existing_entry

    payment_entry = get_payment_entry(
        "Purchase Invoice",
        invoice_id,
        party_amount=amount,
        bank_account=bank_gl_account,
        bank_amount=amount
    )

    payment_entry.paid_from = bank_gl_account
    if mode_of_payment:
        payment_entry.mode_of_payment = mode_of_payment
    payment_entry.reference_no = bank_reference or transaction_id
    payment_entry.reference_date = today()
    payment_entry.custom_transaction_id = transaction_id
    payment_entry.remarks = f"Automated settlement for Transaction ID: {transaction_id}"

    payment_entry.insert(ignore_permissions=True)
    payment_entry.submit()
    return payment_entry.name

def call_middleware_payment_check():
    url = (
        "http://middleware_site:8000"
        "/api/method/middleware_app.api.payment.check_pending_payments"
    )

    try:
        response = requests.post(
            url,
            timeout=300
        )

        print("Middleware Status:", response.status_code)
        print("Middleware Response:", response.text)

        response.raise_for_status()

        return response.json()

    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            "Middleware Payment Check Error"
        )
        raise