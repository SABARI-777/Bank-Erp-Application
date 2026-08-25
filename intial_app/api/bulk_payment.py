import frappe
from frappe import _
from frappe.utils import flt, cint
from intial_app.api.payment import (
        create_processing_payment,
        process_payment
    )

def get_invoice_tax(invoice):
    return flt(invoice.taxes_and_charges_added or 0)


def get_invoice_payable(invoice):
    outstanding_amount = flt(invoice.outstanding_amount)
    tax_amount = get_invoice_tax(invoice)
    tax_status = invoice.custom_tax_status or "Pending"
    if tax_status == "Accept":
        payable_amount = outstanding_amount - tax_amount
    else:
        payable_amount = outstanding_amount
    return max(payable_amount, 0)


def validate_purchase_invoice(invoice_name, supplier_name):
    if not invoice_name:
        frappe.throw(_("Purchase Invoice is required."))
    if not supplier_name:
        frappe.throw(_("Supplier is required."))
    try:
        invoice = frappe.get_doc("Purchase Invoice", invoice_name)
    except frappe.DoesNotExistError:
        frappe.throw(
            _("Purchase Invoice {0} does not exist.").format(invoice_name)
        )
    if invoice.supplier != supplier_name:
        frappe.throw(
            _("Purchase Invoice {0} does not belong to Supplier {1}.").format(
                invoice_name, supplier_name
            )
        )
    if invoice.docstatus != 1:
        frappe.throw(
            _("Purchase Invoice {0} must be submitted.").format(invoice_name)
        )
    if flt(invoice.outstanding_amount) <= 0:
        frappe.throw(
            _("Purchase Invoice {0} has no outstanding amount.").format(
                invoice_name
            )
        )
    return invoice


def validate_bulk_payment(doc, method=None):
    if not doc.supplier_details:
        frappe.throw(_("At least one Supplier is required."))
    if not doc.purchase_invoice_details:
        frappe.throw(_("At least one Purchase Invoice is required."))

    suppliers = set()
    for row in doc.supplier_details:
        if not row.supplier_name:
            frappe.throw(_("Supplier Name is required."))
        if row.supplier_name in suppliers:
            frappe.throw(
                _("Supplier {0} is entered more than once.").format(
                    row.supplier_name
                )
            )
        suppliers.add(row.supplier_name)

    invoice_names = set()
    for row in doc.purchase_invoice_details:
        if not row.supplier:
            frappe.throw(_("Supplier is required for Purchase Invoice row."))
        if not row.purchase_invoice_id:
            frappe.throw(_("Purchase Invoice ID is required."))
        if row.purchase_invoice_id in invoice_names:
            frappe.throw(
                _("Purchase Invoice {0} is entered more than once.").format(
                    row.purchase_invoice_id
                )
            )
        invoice_names.add(row.purchase_invoice_id)
        if row.supplier not in suppliers:
            frappe.throw(
                _("Supplier {0} is not present in Supplier Details.").format(
                    row.supplier
                )
            )

        invoice = validate_purchase_invoice(
            row.purchase_invoice_id, row.supplier
        )
        row.outstanding_amount = flt(invoice.outstanding_amount)
        row.tax_amount = get_invoice_tax(invoice)
        row.payable_amount = get_invoice_payable(invoice)
        row.amount_paid = flt(row.amount_paid or 0)

    for supplier_row in doc.supplier_details:
        total_outstanding = 0
        total_tax = 0
        total_payable = 0
        for invoice_row in doc.purchase_invoice_details:
            if invoice_row.supplier != supplier_row.supplier_name:
                continue
            total_outstanding += flt(invoice_row.outstanding_amount)
            total_tax += flt(invoice_row.tax_amount)
            total_payable += flt(invoice_row.payable_amount)

        supplier_row.total_outstanding = total_outstanding
        supplier_row.total_tax = total_tax
        supplier_row.payable_amount = total_payable


@frappe.whitelist()
def get_supplier_invoices(bulk_payment_name, supplier_name):
    if not bulk_payment_name:
        frappe.throw("Bulk Payment is required.")
    if not supplier_name:
        frappe.throw("Supplier is required.")

    doc = frappe.get_doc("Bulk Payment", bulk_payment_name)
    invoices = []
    for row in doc.purchase_invoice_details:
        if row.supplier != supplier_name:
            continue
        if not row.purchase_invoice_id:
            continue

        invoice = frappe.get_doc("Purchase Invoice", row.purchase_invoice_id)
        outstanding = flt(invoice.outstanding_amount or 0)
        tax_amount = get_invoice_tax(invoice)
        tax_status = invoice.custom_tax_status or "Pending"
        if tax_status == "Accept":
            payable = max(outstanding - tax_amount, 0)
        else:
            payable = outstanding

        invoices.append({
            "name": row.name,
            "supplier": invoice.supplier,
            "purchase_invoice_id": invoice.name,
            "outstanding_amount": outstanding,
            "tax_amount": tax_amount,
            "payable_amount": payable,
            "amount_paid": flt(row.amount_paid or 0)
        })

    if not invoices:
        frappe.throw(
            f"No Purchase Invoices found for Supplier {supplier_name}."
        )

    return {
        "success": True,
        "supplier": supplier_name,
        "invoices": invoices
    }


@frappe.whitelist()
def save_supplier_payment(bulk_payment_name, supplier_name, payments):
    if not bulk_payment_name:
        frappe.throw("Bulk Payment is required.")
    if not supplier_name:
        frappe.throw("Supplier is required.")
    if isinstance(payments, str):
        payments = frappe.parse_json(payments)

    doc = frappe.get_doc("Bulk Payment", bulk_payment_name)
    validated_payments = []

    for item in payments:
        row_name = item.get("row_name")
        amount = flt(item.get("amount_paid") or 0)
        row = next(
            (r for r in doc.purchase_invoice_details if r.name == row_name),
            None
        )
        if not row:
            frappe.throw("Purchase Invoice row not found.")
        if row.supplier != supplier_name:
            frappe.throw("Invalid supplier for Purchase Invoice.")

        invoice = frappe.get_doc("Purchase Invoice", row.purchase_invoice_id)
        for install in invoice.get("custom_install", []):
            if install.payment_status in ("Pending", "Processing"):
                frappe.throw(
                    (
                        "Payment cannot be saved. "
                        "Purchase Invoice {0} already has a {1} payment."
                    ).format(invoice.name, install.payment_status)
                )

        outstanding = flt(invoice.outstanding_amount or 0)
        tax_amount = get_invoice_tax(invoice)
        tax_status = invoice.custom_tax_status or "Pending"
        if tax_status == "Accept":
            payable = max(outstanding - tax_amount, 0)
        else:
            payable = outstanding

        if amount < 0:
            frappe.throw(
                f"Payment amount cannot be negative for {invoice.name}."
            )
        if amount > payable:
            frappe.throw(
                (
                    "Payment amount ₹{0} cannot exceed "
                    "payable amount ₹{1} for {2}."
                ).format(amount, payable, invoice.name)
            )

        validated_payments.append({
            "row_name": row.name,
            "supplier": supplier_name,
            "purchase_invoice_id": invoice.name,
            "outstanding_amount": outstanding,
            "tax_amount": tax_amount,
            "payable_amount": payable,
            "amount_paid": amount
        })

    for item in validated_payments:
        row = next(
            (r for r in doc.purchase_invoice_details if r.name == item["row_name"]),
            None
        )
        row.outstanding_amount = item["outstanding_amount"]
        row.tax_amount = item["tax_amount"]
        row.payable_amount = item["payable_amount"]
        row.amount_paid = item["amount_paid"]

    bulk_data = {}
    if doc.bulk_payment_data:
        try:
            bulk_data = frappe.parse_json(doc.bulk_payment_data)
        except Exception:
            bulk_data = {}

    if not bulk_data.get("suppliers"):
        bulk_data["suppliers"] = []

    supplier_data = {
        "supplier": supplier_name,
        "invoices": [
            {
                "purchase_invoice_id": item["purchase_invoice_id"],
                "amount_paid": item["amount_paid"]
            }
            for item in validated_payments
            if item["amount_paid"] > 0
        ]
    }

    existing_supplier = next(
        (
            item for item in bulk_data["suppliers"]
            if item.get("supplier") == supplier_name
        ),
        None
    )
    if existing_supplier:
        existing_supplier["invoices"] = supplier_data["invoices"]
    else:
        bulk_data["suppliers"].append(supplier_data)

    doc.bulk_payment_data = frappe.as_json(bulk_data, indent=2)

    supplier_row = next(
        (
            row for row in doc.supplier_details
            if row.supplier_name == supplier_name
        ),
        None
    )
    if supplier_row:
        supplier_row.total_outstanding = sum(
            flt(row.outstanding_amount)
            for row in doc.purchase_invoice_details
            if row.supplier == supplier_name
        )
        supplier_row.total_tax = sum(
            flt(row.tax_amount)
            for row in doc.purchase_invoice_details
            if row.supplier == supplier_name
        )
        supplier_row.payable_amount = sum(
            flt(row.payable_amount)
            for row in doc.purchase_invoice_details
            if row.supplier == supplier_name
        )

    doc.save(ignore_permissions=True)
    return {
        "success": True,
        "message": "Bulk payment details saved successfully.",
        "supplier": supplier_name
    }


@frappe.whitelist()
def recalculate_bulk_payment(bulk_payment_name):
    if not bulk_payment_name:
        frappe.throw("Bulk Payment is required.")

    doc = frappe.get_doc("Bulk Payment", bulk_payment_name)
    for row in doc.purchase_invoice_details:
        if not row.purchase_invoice_id:
            continue
        invoice = frappe.get_doc("Purchase Invoice", row.purchase_invoice_id)
        outstanding = flt(invoice.outstanding_amount or 0)
        tax_amount = get_invoice_tax(invoice)
        tax_status = invoice.custom_tax_status or "Pending"
        if tax_status == "Accept":
            payable = max(outstanding - tax_amount, 0)
        else:
            payable = outstanding

        row.outstanding_amount = outstanding
        row.tax_amount = tax_amount
        row.payable_amount = payable

    for supplier_row in doc.supplier_details:
        supplier = supplier_row.supplier_name
        supplier_row.total_outstanding = sum(
            flt(row.outstanding_amount)
            for row in doc.purchase_invoice_details
            if row.supplier == supplier
        )
        supplier_row.total_tax = sum(
            flt(row.tax_amount)
            for row in doc.purchase_invoice_details
            if row.supplier == supplier
        )
        supplier_row.payable_amount = sum(
            flt(row.payable_amount)
            for row in doc.purchase_invoice_details
            if row.supplier == supplier
        )

    doc.save(ignore_permissions=True)
    return {
        "success": True,
        "message": "Bulk Payment recalculated successfully."
    }


@frappe.whitelist()
def get_bulk_payment_details(bulk_payment_name):
    if not bulk_payment_name:
        frappe.throw(_("Bulk Payment is required."))

    doc = frappe.get_doc("Bulk Payment", bulk_payment_name)
    if not doc.purchase_invoice_details:
        frappe.throw(_("No Purchase Invoices found."))

    invoices = []
    total_amount = 0
    for row in doc.purchase_invoice_details:
        amount_paid = flt(row.amount_paid or 0)
        if amount_paid <= 0:
            continue
        if not row.purchase_invoice_id:
            frappe.throw(_("Purchase Invoice ID is missing."))

        invoice = frappe.get_doc("Purchase Invoice", row.purchase_invoice_id)
        if invoice.docstatus != 1:
            frappe.throw(
                _("Purchase Invoice {0} is not submitted.").format(invoice.name)
            )

        outstanding_amount = flt(invoice.outstanding_amount or 0)
        if outstanding_amount <= 0:
            frappe.throw(
                _("Purchase Invoice {0} has no outstanding amount.").format(
                    invoice.name
                )
            )

        for installation in invoice.get("custom_install", []):
            payment_status = (installation.payment_status or "").strip()
            if payment_status in ("Pending", "Processing"):
                frappe.throw(
                    _(
                        "Payment cannot start for {0}. "
                        "It already has a {1} payment."
                    ).format(invoice.name, payment_status)
                )

        if amount_paid > outstanding_amount:
            frappe.throw(
                _(
                    "Payment amount ₹{0} for {1} "
                    "cannot exceed current outstanding amount ₹{2}."
                ).format(amount_paid, invoice.name, outstanding_amount)
            )

        if not invoice.supplier:
            frappe.throw(
                _("Supplier is missing in Purchase Invoice {0}.").format(
                    invoice.name
                )
            )

        supplier = frappe.get_doc("Supplier", invoice.supplier)
        receiver_bank_account = supplier.default_bank_account
        if not receiver_bank_account:
            frappe.throw(
                _(
                    "Supplier {0} does not have a "
                    "Company Bank Account configured."
                ).format(supplier.name)
            )

        bank_account = frappe.get_doc("Bank Account", receiver_bank_account)
        receiver_account = bank_account.bank_account_no
        if not receiver_account:
            frappe.throw(
                _("Bank Account {0} does not have a Bank Account No.").format(
                    bank_account.name
                )
            )

        invoices.append({
            "row_name": row.name,
            "purchase_invoice_id": invoice.name,
            "supplier": invoice.supplier,
            "receiver_bank_account": receiver_bank_account,
            "receiver_account": receiver_account,
            "amount": amount_paid,
            "outstanding_amount": outstanding_amount
        })
        total_amount += amount_paid

    if not invoices:
        frappe.throw(_("No Purchase Invoice has a payment amount."))

    return {
        "success": True,
        "bulk_payment": doc.name,
        "invoices": invoices,
        "total_amount": total_amount
    }


@frappe.whitelist()
def submit_bulk_payment(
    bulk_payment_name,
    otp_verification_id,
    sender_account,
    mode_of_payment,
    sender_mobile,
    transactions
):
    if (
        not bulk_payment_name
        or not otp_verification_id
        or not sender_account
        or not mode_of_payment
        or not sender_mobile
    ):
        frappe.throw(_("All payment parameters are required."))

    if isinstance(transactions, str):
        transactions = frappe.parse_json(transactions)

    bulk_payment = frappe.get_doc("Bulk Payment", bulk_payment_name)
    txn_map = {t["invoice_id"]: t["transaction_id"] for t in transactions}

   

    results = []
    for row in bulk_payment.purchase_invoice_details:
        amount = flt(row.amount_paid or 0)
        if amount <= 0:
            continue

        invoice = frappe.get_doc("Purchase Invoice", row.purchase_invoice_id)
        supplier = frappe.get_doc("Supplier", invoice.supplier)
        receiver_bank_account = supplier.default_bank_account
        receiver_account_number = frappe.db.get_value(
            "Bank Account", receiver_bank_account, "bank_account_no"
        )

        transaction_id = txn_map.get(invoice.name)
        if not transaction_id:
            frappe.throw(
                _("Transaction ID missing for invoice {0}.").format(invoice.name)
            )

        processing_result = create_processing_payment(
            invoice_id=invoice.name,
            amount=amount,
            mobile=sender_mobile,
            transaction_id=transaction_id,
            sender_account=sender_account,
            mode_of_payment=mode_of_payment,
            otp_verification_id=otp_verification_id
        )

        install_no = processing_result.get("installation_no")

        response = process_payment(
            transaction_id=transaction_id,
            amount=amount,
            invoice_id=invoice.name,
            mobile=sender_mobile,
            receiver_bank_account=receiver_bank_account,
            mode_of_payment=mode_of_payment,
            sender_account=sender_account,
            install_no=install_no
        )

        results.append({
            "purchase_invoice_id": invoice.name,
            "transaction_id": transaction_id,
            "installation_no": install_no,
            "amount": amount,
            "status": response.get("status"),
            "bank_reference": response.get("bank_reference"),
            "message": response.get("message")
        })

    return {
        "success": True,
        "bulk_payment": bulk_payment.name,
        "results": results
    }