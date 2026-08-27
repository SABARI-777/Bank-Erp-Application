import frappe


def get_tax_permission():

    user_roles = set(
        frappe.get_roles(frappe.session.user)
    )

    permission_roles = frappe.get_all(
        "Permission Check",
        filters={
            "roles": ["is", "set"]
        },
        pluck="roles"
    )

    permission_roles = set(permission_roles)

    matched_roles = user_roles.intersection(
        permission_roles
    )

    return {
        "allowed": bool(matched_roles),
        "matched_role": (
            list(matched_roles)[0]
            if matched_roles
            else None
        )
    }


@frappe.whitelist()
def check_tax_permission():

    return get_tax_permission()


def validate_tax_hold(doc, method=None):

    # New document
    if doc.is_new():
        return

    old_doc = doc.get_doc_before_save()

    if not old_doc:
        return

    old_hold = old_doc.custom_tax_hold
    new_hold = doc.custom_tax_hold

    # Nothing changed
    if old_hold == new_hold:
        return

    permission = get_tax_permission()

    if not permission["allowed"]:
        frappe.throw(
            "You do not have permission to change Tax Hold."
        )

@frappe.whitelist()
def update_tax_status(invoice_name, decision):

    if decision not in ["Accept", "Reject"]:
        frappe.throw("Invalid tax decision.")

    permission = get_tax_permission()

    if not permission["allowed"]:
        frappe.throw(
            "You do not have permission to make Tax Decision."
        )

    invoice = frappe.get_doc(
        "Purchase Invoice",
        invoice_name
    )

    if invoice.docstatus != 1:
        frappe.throw(
            "Purchase Invoice must be submitted before making Tax Decision."
        )

    if decision == "Accept":
         invoice.db_set(
            "custom_tax_hold",
            1,
            update_modified=True
        )

    elif decision == "Reject":
        invoice.db_set(
            "custom_tax_hold",
            0,
            update_modified=True
        )

    return {
        "success": True,
        "invoice": invoice.name,
        "decision": decision,
        "custom_tax_hold": (
            1 if decision == "Accept" else 0
        )
    }