import frappe
import requests
import json


@frappe.whitelist()
def request_otp(mobile):
    if not mobile:
        frappe.throw("Mobile number is required.")

    payload = {"mobile": mobile}

    response = requests.post(
        "http://middleware_site:8000/api/method/middleware_app.api.payment.request_otp",
        json=payload,
        timeout=15
    )

    if response.status_code != 200:
        frappe.throw("Middleware Error: " + response.text)

    return response.json().get("message")


@frappe.whitelist()
def verify_otp(transaction_id, otp_verification_id, otp):
    if not transaction_id:
        frappe.throw("Transaction ID is required.")

    if not otp_verification_id:
        frappe.throw("OTP Verification ID is required.")

    if not otp:
        frappe.throw("OTP is required.")

    payload = {
        "transaction_id": transaction_id,
        "otp_verification_id": otp_verification_id,
        "otp": otp
    }

    response = requests.post(
        "http://middleware_site:8000/api/method/middleware_app.api.payment.verify_otp",
        json=payload,
        timeout=15
    )

    if response.status_code != 200:
        frappe.throw("Middleware Error: " + response.text)

    return response.json().get("message")


@frappe.whitelist()
def save_otp_failure(invoice_id, transaction_id, error, otp_entered, mobile, attempt_no):
    if not invoice_id:
        frappe.throw("Purchase Invoice is required.")

    invoice = frappe.get_doc("Purchase Invoice", invoice_id)

    row = invoice.append("custom_error_log", {})
    row.error = error
    row.otp_entered = otp_entered
    row.time = frappe.utils.now()
    row.mobile = mobile
    row.transaction_id = transaction_id
    row.attempt_no = attempt_no

    invoice.save(ignore_permissions=True)

    return {
        "success": True,
        "message": "OTP failure recorded successfully."
    }


@frappe.whitelist()
def process_payment(
    transaction_id,
    amount,
    invoice_id,
    mobile,
    receiver_bank_account=None,
    mode_of_payment=None,
    sender_account=None
):
    if not transaction_id:
        frappe.throw("Transaction ID is required.")

    if not amount or float(amount) <= 0:
        frappe.throw("Payment amount must be greater than zero.")

    payload = {
        "transaction_id": transaction_id,
        "amount": float(amount),
        "invoice_id": invoice_id,
        "mobile": mobile,
        "receiver_bank_account": receiver_bank_account,
        "mode_of_payment": mode_of_payment,
        "sender_account": sender_account
    }

    response = requests.post(
        "http://middleware_site:8000/api/method/middleware_app.api.payment.process_payment",
        json=payload,
        timeout=30
    )

    if response.status_code != 200:
        frappe.throw("Middleware Error: " + response.text)

    return response.json().get("message")

@frappe.whitelist()
def save_payment_result(
    invoice_id,
    transaction_id,
    amount,
    mobile,
    status,
    bank_reference=None,
    failure_reason=None
):

    if not invoice_id:
        frappe.throw(
            "Purchase Invoice ID is required."
        )

    if not transaction_id:
        frappe.throw(
            "Transaction ID is required."
        )

    invoice = frappe.get_doc(
        "Purchase Invoice",
        invoice_id
    )
 
    row = None

    for existing_row in invoice.custom_install:

        if (
            existing_row.transaction_id
            == transaction_id
        ):
            row = existing_row
            break
 

    if not row:

        frappe.throw(
            f"Installation Payment not found "
            f"for {transaction_id}"
        )
 

    row.amount = amount

    row.mobile = mobile

    row.otp_status = "Verified"

    row.transaction_id = transaction_id
 

    if str(status).upper() == "SUCCESS":

        row.payment_status = "Success"

        row.bank_reference = (
            bank_reference
        )

        row.failure_reason = None

        row.paid_at = (
            frappe.utils.now()
        )
 

    else:

        row.payment_status = "Failed"

        row.failure_reason = (
            failure_reason
            or "Payment failed."
        )

        row.bank_reference = None
 

    invoice.save(
        ignore_permissions=True
    )

    return {

        "success": True,

        "installation_no":
            row.installation_no,

        "ref_no":
            row.ref_no,

        "transaction_id":
            row.transaction_id,

        "payment_status":
            row.payment_status,

        "bank_reference":
            row.bank_reference,

        "failure_reason":
            row.failure_reason
    }