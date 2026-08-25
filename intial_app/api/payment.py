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

    response = requests.post(
        f"{MIDDLEWARE_URL}.request_otp",
        json={"mobile": mobile},
        timeout=20
    )
    if response.status_code != 200:
        frappe.throw(_("Middleware Request Error: {0}").format(response.text))

    return response.json().get("message")


@frappe.whitelist(allow_guest=True)
def verify_otp(
    otp_verification_id,
    otp,
    invoice_id,
    mobile=None,
    receiver_bank_account=None,
    mode_of_payment=None,
    sender_account=None
):
    if not otp_verification_id or not otp or not invoice_id:
        frappe.throw(_("Verification ID, OTP, and Invoice ID are mandatory."))

    receiver_account_no = None
    if receiver_bank_account:
        receiver_account_no = frappe.db.get_value(
            "Bank Account", receiver_bank_account, "bank_account_no"
        )

    invoice = frappe.get_doc("Purchase Invoice", invoice_id)
    existing_numbers = [
        cint(row.installation_no or 0)
        for row in invoice.get("custom_install", [])
    ]
    next_install_no = max([0] + existing_numbers) + 1

    payload = {
        "otp_verification_id": otp_verification_id,
        "otp": otp,
        "invoice_id": invoice_id,
        "mobile": mobile,
        "install_no": next_install_no,
        "receiver_bank_account": receiver_bank_account,
        "receiver_account_number": receiver_account_no,
        "mode_of_payment": mode_of_payment,
        "sender_account": sender_account
    }

    response = requests.post(
        f"{MIDDLEWARE_URL}.verify_otp",
        json=payload,
        timeout=20
    )
    if response.status_code != 200:
        frappe.throw(_("Middleware Verification Error: {0}").format(response.text))

    return response.json().get("message")


@frappe.whitelist(allow_guest=True)
def verify_bulk_otp(otp_verification_id, otp, invoices, mobile=None):
    if not otp_verification_id or not otp or not invoices:
        frappe.throw(_("Verification ID, OTP, and Invoices are mandatory."))

    if isinstance(invoices, str):
        invoices = frappe.parse_json(invoices)

    payload = {
        "otp_verification_id": otp_verification_id,
        "otp": otp,
        "invoices": invoices,
        "mobile": mobile
    }

    response = requests.post(
        f"{MIDDLEWARE_URL}.verify_bulk_otp",
        json=payload,
        timeout=30
    )
    if response.status_code != 200:
        frappe.throw(_("Middleware Bulk Verification Error: {0}").format(response.text))

    return response.json().get("message")

@frappe.whitelist(allow_guest=True)
def save_otp_failure(
    invoice_id,
    ref_no,
    error,
    otp_entered,
    mobile,
    attempt_no
):

    if not invoice_id:
        frappe.throw(_("Purchase Invoice is required."))

    invoice = frappe.get_doc(
        "Purchase Invoice",
        invoice_id
    )

    row = invoice.append(
        "custom_error_log",
        {}
    )

    row.ref_no = ref_no
    row.error = error
    row.otp_entered = otp_entered
    row.mobile = mobile
    row.time = now()
    row.attempt_no = attempt_no

    invoice.save(
        ignore_permissions=True
    )

    return {
        "success": True,
        "message": "OTP failure recorded.",
        "invoice_id": invoice.name,
        "ref_no": ref_no,
        "attempt_no": attempt_no
    }

@frappe.whitelist(allow_guest=True)
def create_processing_payment(
    invoice_id,
    amount,
    mobile,
    transaction_id,
    sender_account=None,
    mode_of_payment=None,
    otp_verification_id=None
):
    amount = flt(amount)
    if amount <= 0:
        frappe.throw(_("Payment amount must be greater than zero."))

    invoice = frappe.get_doc("Purchase Invoice", invoice_id)
    tax_status = invoice.custom_tax_status or "Pending"
    outstanding_amount = flt(invoice.outstanding_amount)
    tax_amount = flt(invoice.taxes_and_charges_added)

    if tax_status == "Accept":
        payable_amount = outstanding_amount - tax_amount
    else:
        payable_amount = outstanding_amount

    payable_amount = max(payable_amount, 0)

    if amount > payable_amount:
        frappe.throw(
            _(
                "Payment amount cannot exceed ₹{0}. "
                "Outstanding: ₹{1}, Tax: ₹{2}, Tax Status: {3}"
            ).format(
                frappe.format_value(payable_amount, {"fieldtype": "Currency"}),
                frappe.format_value(outstanding_amount, {"fieldtype": "Currency"}),
                frappe.format_value(tax_amount, {"fieldtype": "Currency"}),
                tax_status
            )
        )

    for row in invoice.get("custom_install", []):
        if row.payment_status in ("Pending", "Processing"):
            frappe.throw(_("A payment is already Pending or Processing."))

    existing_numbers = [
        cint(row.installation_no or 0)
        for row in invoice.get("custom_install", [])
    ]
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
def process_payment(
    transaction_id,
    amount,
    invoice_id,
    mobile,
    receiver_bank_account,
    mode_of_payment,
    sender_account,
    install_no=None
):
    if not sender_account or not receiver_bank_account:
        frappe.throw(
            _("Sender and Receiver Bank Accounts are required.")
        )

    bank_account_doc = frappe.get_doc(
        "Bank Account",
        receiver_bank_account
    )

    receiver_account_no = bank_account_doc.bank_account_no

    if not receiver_account_no:
        frappe.throw(
            _("Bank Account '{0}' has no Bank Account Number.").format(
                receiver_bank_account
            )
        )

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


    response = requests.post(
        f"{MIDDLEWARE_URL}.process_payment",
        json=payload,
        timeout=300
    )

    if response.status_code != 200:
        frappe.throw(
            _("Middleware Processing Error: {0}").format(
                response.text
            )
        )


    response_data = response.json()

    result = response_data.get("message") or {}

    print("DIRECT BANK RESULT:", result)

    status = str(
        result.get("status") or ""
    ).strip().upper()

  

    failure_reason = (
        result.get("failure_reason")
        or result.get("reason")
        or result.get("message")
    )


    save_payment_result(
        invoice_id=invoice_id,
        transaction_id=transaction_id,
        amount=amount,
        mobile=mobile,
        status=status,
        failure_reason=failure_reason,
        sender_account=sender_account,
        mode_of_payment=mode_of_payment,
        install_no=install_no
    )

    return result


@frappe.whitelist(allow_guest=True)
def save_payment_result(
    invoice_id,
    transaction_id,
    amount,
    mobile,
    status,
    bank_reference=None,
    failure_reason=None,
    sender_account=None,
    mode_of_payment=None,
    install_no=None
):
    invoice = frappe.get_doc("Purchase Invoice", invoice_id)

    row = next(
        (
            r for r in invoice.get("custom_install", [])
            if r.transaction_id == transaction_id
        ),
        None
    )

    if not row and install_no:
        row = next(
            (
                r for r in invoice.get("custom_install", [])
                if str(r.installation_no) == str(install_no)
            ),
            None
        )

    if not row:
        frappe.throw(
            _("Installation record not found for transaction {0}.").format(
                transaction_id
            )
        )

    row.amount = flt(amount)
    if mobile:
        row.mobile = mobile

    status_upper = str(status).strip().upper()


    if status_upper in ("SUCCESS", "COMPLETED"):
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

        row.db_set(
            "payment_entry",
            payment_entry_name,
            update_modified=True
        )

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

    elif status_upper in ("FAILED", "REJECTED", "ERROR", "FAILURE"):
        row.payment_status = "Failed"
        row.failure_reason = failure_reason or "Bank declined payment."
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

    else:
        frappe.throw(_("Unknown bank payment status: {0}").format(status))


def create_payment_entry_for_invoice(
    invoice_id,
    transaction_id,
    amount,
    sender_account,
    mode_of_payment=None,
    bank_reference=None
):
    invoice = frappe.get_doc("Purchase Invoice", invoice_id)
    if invoice.docstatus != 1:
        frappe.throw(_("Purchase Invoice must be submitted to generate Payment Entry."))

    bank_account_doc = frappe.get_doc("Bank Account", sender_account)
    bank_gl_account = bank_account_doc.account

    existing_entry = frappe.db.get_value(
        "Payment Entry",
        {"custom_transaction_id": transaction_id},
        "name"
    )
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
    payment_entry.remarks = (
        f"Automated settlement for Transaction ID: {transaction_id}"
    )

    payment_entry.insert(ignore_permissions=True)
    payment_entry.submit()
    return payment_entry.name


def call_middleware_payment_check():
    url = (
        "http://middleware_site:8000"
        "/api/method/middleware_app.api.payment.check_pending_payments"
    )
    try:
        response = requests.post(url, timeout=300)
        response.raise_for_status()
        return response.json()
    except Exception:
        frappe.log_error(frappe.get_traceback(), "Middleware Payment Check Error")
        raise