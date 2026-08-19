import frappe

def on_payment_entry_submit(doc, method):

    purchase_invoice = None

    for ref in doc.references:
        if ref.reference_doctype == "Purchase Invoice":
            purchase_invoice = ref.reference_name
            break

    if not purchase_invoice:
        return

    invoice = frappe.get_doc(
        "Purchase Invoice",
        purchase_invoice
    )

    install_no = max(
        [
            row.install_no or 0
            for row in invoice.installation_payments
        ],
        default=0
    ) + 1

    row = invoice.append(
        "custom_install",
        {}
    )

    row.install_no = install_no
    row.amount = doc.paid_amount
    row.payment_status = "Success"
    row.payment_entry = doc.name
    row.paid_at = frappe.utils.now()

    invoice.save(
        ignore_permissions=True
    )