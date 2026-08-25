import frappe

def get_tax_permission():

    user_roles = set(frappe.get_roles(frappe.session.user))

    permission_roles = frappe.get_all(
        "Permission Check",
        filters={
            "roles": ["is", "set"]
        },
        pluck="roles"
    )

    permission_roles = set(permission_roles)

    matched_roles = user_roles.intersection(permission_roles)

    return {
        "allowed": bool(matched_roles),
        "matched_role": list(matched_roles)[0] if matched_roles else None
    }


@frappe.whitelist()
def check_tax_permission():
    return get_tax_permission()


def validate_tax_hold(doc, method=None):

    if doc.is_new():
        return

    old_doc = doc.get_doc_before_save()

    if not old_doc:
        return

    old_status = old_doc.custom_tax_status or "Pending"
    new_status = doc.custom_tax_status or "Pending"

   
    if old_status == new_status:
        return

    permission = get_tax_permission()

    if not permission["allowed"]:
        frappe.throw(
            "You do not have permission to change Tax Status."
        )

@frappe.whitelist()
def update_tax_status(invoice_name, status):
   

    if status not in ["Accept", "Reject"]:
        frappe.throw("Invalid Tax Status.")

 
    permission = get_tax_permission()

    if not permission["allowed"]:
        frappe.throw(
            "You do not have permission to change Tax Status."
        )

    invoice = frappe.get_doc("Purchase Invoice", invoice_name)
 
    invoice.db_set(
        "custom_tax_status",
        status,
        update_modified=True
    )

    return {
        "success": True,
        "invoice": invoice.name,
        "status": status
    }