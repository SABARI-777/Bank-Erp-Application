# Copyright (c) 2026, sab and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import flt
from frappe.model.document import Document


class BulkPayment(Document):

	def validate(self):
		if not self.supplier_details:
			frappe.throw(_("Please add at least one Supplier."))

		suppliers_seen = set()
		for supplier_row in self.supplier_details:

			if not supplier_row.supplier_name:
				frappe.throw(
					_("Supplier Name is required.")
				)

			validate_supplier_not_in_pending_bulk_payment(
				supplier_row.supplier_name,
				self.name
			)

			validate_supplier_payment_status(
				supplier_row.supplier_name
			)

			supplier_key = supplier_row.supplier_name.strip().lower()

			if supplier_key in suppliers_seen:
				frappe.throw(_("Supplier {0} is already added to this Bulk Payment. The same supplier cannot be added twice.").format(supplier_row.supplier_name))

			suppliers_seen.add(supplier_key)

			if not supplier_row.supplier_account:
				summary = get_supplier_payment_summary(supplier_row.supplier_name)
				supplier_row.supplier_account = summary["supplier_account"]
				supplier_row.total_outstanding = summary["total_outstanding"]
				supplier_row.total_tax = summary["total_tax"]
				supplier_row.payable_amount = summary["payable_amount"]

			if supplier_row.json:
				try:
					payment_data = frappe.parse_json(supplier_row.json)
				except Exception:
					frappe.throw(_("Invalid payment JSON for Supplier {0}.").format(supplier_row.supplier_name))

				for selected_invoice in payment_data.get("invoices", []):
					invoice_name = selected_invoice.get("purchase_invoice_id")
					if invoice_name:
						validate_invoice_not_in_pending_bulk_payment(invoice_name, self.name)


def get_invoice_tax(invoice):
    return flt(invoice.taxes_and_charges_added or 0)

def has_active_payment(invoice):
    for installation in invoice.get("custom_install", []):
        if (installation.payment_status or "").strip() in ("Pending", "Processing"):
            return True
    return False

def get_invoice_payable(invoice):
    outstanding_amount = flt(invoice.outstanding_amount or 0)
    tax_amount = get_invoice_tax(invoice)
    payable_amount = outstanding_amount - tax_amount if invoice.custom_tax_hold else outstanding_amount
    return max(payable_amount, 0)


def validate_supplier_not_in_pending_bulk_payment(supplier_name, current_bulk_payment=None):
    bulk_payments = frappe.get_all("Bulk Payment", filters={"docstatus": 1, "completed": 0}, fields=["name"])

    for bulk_payment in bulk_payments:
        if current_bulk_payment and bulk_payment.name == current_bulk_payment:
            continue

        if frappe.db.exists("Supplier Details", {"parent": bulk_payment.name, "parenttype": "Bulk Payment", "supplier_name": supplier_name}):
            frappe.throw(
                _("Supplier {0} is already present in submitted Bulk Payment {1}, which is not completed. You cannot add this Supplier.").format(
                    supplier_name, bulk_payment.name
                )
            )


def validate_supplier_payment_status(supplier_name):

    purchase_invoices = frappe.get_all(
        "Purchase Invoice",
        filters={
            "supplier": supplier_name,
            "docstatus": 1,
            "outstanding_amount": [">", 0]
        },
        pluck="name"
    )

    if not purchase_invoices:
        frappe.throw(
            _(
                "Supplier {0} has no submitted Purchase Invoice "
                "with outstanding amount."
            ).format(supplier_name)
        )

    has_eligible_invoice = False

    for invoice_name in purchase_invoices:

        invoice = frappe.get_doc(
            "Purchase Invoice",
            invoice_name
        )

        if has_active_payment(invoice):
            continue

        payable_amount = get_invoice_payable(invoice)

        if payable_amount <= 0:
            continue

      
        has_eligible_invoice = True

    if not has_eligible_invoice:

        frappe.throw(
            _(
                "Supplier {0} has no eligible Purchase Invoice "
                "available for payment."
            ).format(supplier_name)
        )

def get_supplier_payment_summary(supplier_name):
    if not supplier_name:
        frappe.throw(_("Supplier is required."))

    supplier = frappe.get_doc("Supplier", supplier_name)
    supplier_account = supplier.default_bank_account or frappe.db.get_value(
        "Bank Account",
        {"party_type": "Supplier", "party": supplier_name},
        "name",
        order_by="is_default desc, creation desc"
    )

    if not supplier_account:
        frappe.throw(_("Supplier {0} does not have a Bank Account.").format(supplier_name))

    bank_account = frappe.get_doc("Bank Account", supplier_account)
    if not bank_account.bank_account_no:
        frappe.throw(_("Bank Account {0} does not have a Bank Account Number.").format(supplier_account))

    purchase_invoices = frappe.get_all(
        "Purchase Invoice",
        filters={"supplier": supplier_name, "docstatus": 1, "outstanding_amount": [">", 0]},
        fields=["name", "supplier", "outstanding_amount", "taxes_and_charges_added", "custom_tax_hold"],
        order_by="posting_date asc, creation asc"
    )

    total_outstanding, total_tax, total_payable = 0, 0, 0
    eligible_invoices = []

    for invoice_data in purchase_invoices:
        invoice = frappe.get_doc("Purchase Invoice", invoice_data.name)
        if has_active_payment(invoice):
            continue

        outstanding_amount = flt(invoice.outstanding_amount or 0)
        if outstanding_amount <= 0:
            continue

        tax_amount = get_invoice_tax(invoice)
        payable_amount = get_invoice_payable(invoice)
        if payable_amount <= 0:
            continue

        total_outstanding += outstanding_amount
        total_tax += tax_amount
        total_payable += payable_amount

        eligible_invoices.append({
            "purchase_invoice_id": invoice.name,
            "outstanding_amount": outstanding_amount,
            "tax_amount": tax_amount,
            "payable_amount": payable_amount
        })

    return {
        "supplier": supplier_name,
        "supplier_account": supplier_account,
        "supplier_account_number": bank_account.bank_account_no,
        "total_outstanding": total_outstanding,
        "total_tax": total_tax,
        "payable_amount": total_payable,
        "invoices": eligible_invoices
    }



def validate_invoice_not_in_pending_bulk_payment(invoice_name, current_bulk_payment=None):
    existing = get_submitted_pending_bulk_payment_for_invoice(invoice_name, current_bulk_payment)
    if existing:
        frappe.throw(
            _("Purchase Invoice {0} is already present in submitted Bulk Payment {1} under Supplier {2}.").format(
                invoice_name, existing["bulk_payment"], existing["supplier"]
            )
        )



def get_submitted_pending_bulk_payment_for_invoice(invoice_name, current_bulk_payment=None):
    if not invoice_name:
        return None

    bulk_payments = frappe.get_all("Bulk Payment", filters={"docstatus": 1, "completed": 0}, fields=["name"])

    for bulk_payment in bulk_payments:
        if current_bulk_payment and bulk_payment.name == current_bulk_payment:
            continue

        supplier_rows = frappe.get_all(
            "Supplier Details",
            filters={"parent": bulk_payment.name, "parenttype": "Bulk Payment"},
            fields=["supplier_name", "json"]
        )

        for row in supplier_rows:
            if not row.json:
                continue
            try:
                payment_data = frappe.parse_json(row.json)
            except Exception:
                continue

            for selected_invoice in payment_data.get("invoices", []):
                if selected_invoice.get("purchase_invoice_id") == invoice_name:
                    return {"bulk_payment": bulk_payment.name, "supplier": row.supplier_name}
    return None

