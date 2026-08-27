frappe.ui.form.on("Bulk Payment", {

    setup(frm) {
        setup_supplier_details_grid(frm);
    },

    onload(frm) {

        setup_supplier_details_grid(frm);

        if (
            frm.is_new() &&
            (
                !frm.doc.supplier_details ||
                !frm.doc.supplier_details.length
            )
        ) {

            frm.add_child("supplier_details");

            frm.refresh_field(
                "supplier_details"
            );
        }
    },

    refresh(frm) {

        setup_supplier_details_grid(frm);

        /*
         * Pay button:
         *
         * Only show when:
         * docstatus = 1
         * completed = 0
         */

        if (
            !frm.is_new() &&
            frm.doc.docstatus === 1 &&
            !frm.doc.completed
        ) {

            frm.add_custom_button(
                "Pay",
                function () {

                    start_bulk_payment(frm);

                }
            );
        }
    },

    validate(frm) {

        if (
            !frm.doc.supplier_details ||
            !frm.doc.supplier_details.length
        ) {

            frappe.throw(
                "Please select a Supplier."
            );
        }

        /*
         * Same supplier cannot appear twice
         * in the same Bulk Payment.
         *
         * Backend also validates this.
         */

        const suppliers_seen = new Set();

        frm.doc.supplier_details.forEach(
            function (row) {

                if (!row.supplier_name) {

                    frappe.throw(
                        "Please select a Supplier for every row."
                    );
                }

                const supplier_key =
                    row.supplier_name
                        .trim()
                        .toLowerCase();

                if (
                    suppliers_seen.has(
                        supplier_key
                    )
                ) {

                    frappe.throw(
                        `Supplier ${row.supplier_name} is already added to this Bulk Payment.`
                    );
                }

                suppliers_seen.add(
                    supplier_key
                );
            }
        );
    }
});


/* =========================================================
   SUPPLIER DETAILS GRID
   ========================================================= */

function setup_supplier_details_grid(frm) {

    if (
        !frm.fields_dict.supplier_details
    ) {
        return;
    }

    const grid =
        frm.fields_dict.supplier_details.grid;

    if (!grid) {
        return;
    }

    if (frm.doc.docstatus === 0) {

        grid.cannot_add_rows = false;

        grid.cannot_delete_rows = false;

        frm.set_df_property(
            "supplier_details",
            "read_only",
            0
        );

    } else {

        grid.cannot_add_rows = true;

        grid.cannot_delete_rows = true;

        frm.set_df_property(
            "supplier_details",
            "read_only",
            1
        );
    }
}


/* =========================================================
   SUPPLIER DETAILS CHILD TABLE
   ========================================================= */

frappe.ui.form.on(
    "Supplier Details",
    {

        supplier_name(frm, cdt, cdn) {

            const row =
                locals[cdt][cdn];

            if (!row.supplier_name) {
                return;
            }

            /*
             * Check duplicate supplier immediately.
             */

            const current_supplier =
                row.supplier_name
                    .trim()
                    .toLowerCase();

            let duplicate = false;

            frm.doc.supplier_details.forEach(
                function (other_row) {

                    if (
                        other_row.name === row.name
                    ) {
                        return;
                    }

                    if (
                        other_row.supplier_name &&
                        other_row.supplier_name
                            .trim()
                            .toLowerCase() ===
                        current_supplier
                    ) {

                        duplicate = true;
                    }
                }
            );

            if (duplicate) {

                frappe.msgprint({
                    title: "Duplicate Supplier",
                    message:
                        `Supplier ${row.supplier_name} is already added to this Bulk Payment.`,
                    indicator: "red"
                });

                frappe.model.clear_doc(
                    cdt,
                    cdn
                );

                frm.refresh_field(
                    "supplier_details"
                );
            }
        },


        pay(frm, cdt, cdn) {

            const row =
                locals[cdt][cdn];

            if (!row.supplier_name) {

                frappe.msgprint({

                    title:
                        "Supplier Required",

                    message:
                        "Please select a Supplier first.",

                    indicator:
                        "orange"
                });

                return;
            }

            if (!row.supplier_account) {

                frappe.msgprint({

                    title:
                        "Supplier Account Required",

                    message:
                        "Supplier Bank Account has not been fetched yet. Save the Bulk Payment first.",

                    indicator:
                        "orange"
                });

                return;
            }

            open_supplier_payment_popup(
                frm,
                row.supplier_name
            );
        }
    }
);


/* =========================================================
   COMMON SERVER ERROR MESSAGE
   ========================================================= */

function get_server_error_message(r, fallback) {

    /*
     * Frappe can return the error in:
     *
     * r.message.message
     * r._server_messages
     * r.message
     */

    if (
        r &&
        r.message &&
        typeof r.message === "object" &&
        r.message.message
    ) {

        return r.message.message;
    }

    if (
        r &&
        r._server_messages
    ) {

        try {

            const messages =
                JSON.parse(
                    r._server_messages
                );

            if (
                Array.isArray(messages) &&
                messages.length
            ) {

                const first =
                    messages[0];

                if (
                    typeof first === "string"
                ) {

                    try {

                        const parsed =
                            JSON.parse(first);

                        if (
                            parsed.message
                        ) {

                            return parsed.message;
                        }

                    } catch (e) {

                        return first;
                    }
                }

                if (
                    first &&
                    first.message
                ) {

                    return first.message;
                }
            }

        } catch (e) {
            // Ignore parsing error
        }
    }

    if (
        r &&
        r.message &&
        typeof r.message === "string"
    ) {

        return r.message;
    }

    return fallback;
}


/* =========================================================
   OPEN SUPPLIER PAYMENT POPUP
   ========================================================= */

function open_supplier_payment_popup(
    frm,
    supplier_name
) {

    frappe.call({

        method:
            "intial_app.api.bulk_payment.get_supplier_invoices",

        args: {

            bulk_payment_name:
                frm.doc.name,

            supplier_name:
                supplier_name
        },

        freeze:
            true,

        freeze_message:
            "Loading Purchase Invoices...",

        callback:
            function (r) {

                if (
                    !r.message ||
                    !r.message.success
                ) {

                    frappe.msgprint({

                        title:
                            "Unable to Load Invoices",

                        message:
                            get_server_error_message(
                                r,
                                "Unable to load Purchase Invoices."
                            ),

                        indicator:
                            "red"
                    });

                    return;
                }

                show_supplier_payment_popup(
                    frm,
                    r.message
                );
            }
    });
}


/* =========================================================
   SUPPLIER PAYMENT POPUP
   ========================================================= */

function show_supplier_payment_popup(
    frm,
    data
) {

    let invoice_rows = "";

    (
        data.invoices || []
    ).forEach(
        function (invoice) {

            invoice_rows += `

                <tr
                    data-row-name="${invoice.name}"
                >

                    <td>
                        ${invoice.name}
                    </td>

                    <td>
                        ${invoice.posting_date || ""}
                    </td>

                    <td>
                        ₹${flt(
                            invoice.outstanding_amount
                        ).toFixed(2)}
                    </td>

                    <td>
                        ₹${flt(
                            invoice.tax_amount
                        ).toFixed(2)}
                    </td>

                    <td>
                        ₹${flt(
                            invoice.payable_amount
                        ).toFixed(2)}
                    </td>

                    <td>

                        <input
                            type="number"
                            class="form-control bulk-payment-amount"
                            data-row-name="${invoice.name}"
                            data-payable="${invoice.payable_amount}"
                            value="0"
                            min="0"
                            max="${invoice.payable_amount}"
                        >

                    </td>

                </tr>
            `;
        }
    );


    if (!invoice_rows) {

        frappe.msgprint({

            title:
                "No Eligible Invoices",

            message:
                "There are no Purchase Invoices available for payment.",

            indicator:
                "orange"
        });

        return;
    }


    const dialog =
        new frappe.ui.Dialog({

            title:
                `Payment - ${data.supplier}`,

            size:
                "large",

            fields: [

                {
                    fieldname:
                        "invoice_table",

                    fieldtype:
                        "HTML",

                    options: `

                        <div>

                            <table
                                class="table table-bordered"
                            >

                                <thead>

                                    <tr>

                                        <th>
                                            Purchase Invoice
                                        </th>

                                        <th>
                                            Date
                                        </th>

                                        <th>
                                            Outstanding
                                        </th>

                                        <th>
                                            Tax
                                        </th>

                                        <th>
                                            Payable
                                        </th>

                                        <th>
                                            Payment
                                        </th>

                                    </tr>

                                </thead>

                                <tbody>

                                    ${invoice_rows}

                                </tbody>

                            </table>


                            <div
                                style="
                                    margin-top:10px;
                                    text-align:right;
                                    font-size:16px;
                                "
                            >

                                <strong>

                                    Total Payment:

                                    ₹<span
                                        class="bulk-total"
                                    >
                                        0.00
                                    </span>

                                </strong>

                            </div>

                        </div>
                    `
                }
            ],

            primary_action_label:
                "Save Payment",

            primary_action:
                function () {

                    save_supplier_payment(
                        frm,
                        dialog,
                        data
                    );
                },


            secondary_action_label:
                "Recalculate",

            secondary_action:
                function () {

                    recalculate_payment_popup(
                        frm,
                        dialog,
                        data
                    );
                }
        });


    dialog.show();

    update_bulk_payment_total(
        dialog
    );


    dialog.$wrapper.on(
        "input",
        ".bulk-payment-amount",
        function () {

            const input =
                $(this);

            const payable =
                flt(
                    input.attr(
                        "data-payable"
                    )
                );

            const amount =
                flt(
                    input.val()
                );


            if (
                amount > payable
            ) {

                input.val(
                    payable.toFixed(2)
                );
            }


            if (
                amount < 0
            ) {

                input.val("0");
            }


            update_bulk_payment_total(
                dialog
            );
        }
    );
}


/* =========================================================
   TOTAL
   ========================================================= */

function update_bulk_payment_total(
    dialog
) {

    let total = 0;

    dialog.$wrapper
        .find(
            ".bulk-payment-amount"
        )
        .each(
            function () {

                total += flt(
                    $(this).val()
                );
            }
        );

    dialog.$wrapper
        .find(
            ".bulk-total"
        )
        .text(
            total.toFixed(2)
        );
}


/* =========================================================
   RECALCULATE
   ========================================================= */

function recalculate_payment_popup(
    frm,
    dialog,
    data
) {

    frappe.call({

        method:
            "intial_app.api.bulk_payment.get_supplier_invoices",

        args: {

            bulk_payment_name:
                frm.doc.name,

            supplier_name:
                data.supplier
        },

        freeze:
            true,

        freeze_message:
            "Recalculating payment details...",

        callback:
            function (r) {

                /*
                 * Backend validation error.
                 *
                 * Example:
                 *
                 * PI already exists in
                 * submitted + not completed
                 * Bulk Payment.
                 */

                if (
                    !r.message ||
                    !r.message.success
                ) {

                    frappe.msgprint({

                        title:
                            "Recalculation Failed",

                        message:
                            get_server_error_message(
                                r,
                                "Unable to recalculate payment details."
                            ),

                        indicator:
                            "red"
                    });

                    return;
                }


                const new_data =
                    r.message;


                /*
                 * Update SAME popup.
                 * Do not close/reopen.
                 */

                (
                    new_data.invoices || []
                ).forEach(
                    function (invoice) {

                        const row =
                            dialog.$wrapper.find(
                                `tr[data-row-name="${invoice.name}"]`
                            );

                        if (!row.length) {
                            return;
                        }


                        row.find("td")
                            .eq(2)
                            .text(
                                `₹${flt(
                                    invoice.outstanding_amount
                                ).toFixed(2)}`
                            );


                        row.find("td")
                            .eq(3)
                            .text(
                                `₹${flt(
                                    invoice.tax_amount
                                ).toFixed(2)}`
                            );


                        row.find("td")
                            .eq(4)
                            .text(
                                `₹${flt(
                                    invoice.payable_amount
                                ).toFixed(2)}`
                            );


                        const input =
                            row.find(
                                ".bulk-payment-amount"
                            );


                        input.attr(
                            "data-payable",
                            invoice.payable_amount
                        );


                        input.attr(
                            "max",
                            invoice.payable_amount
                        );


                        const current_amount =
                            flt(
                                input.val()
                            );

                        const new_payable =
                            flt(
                                invoice.payable_amount
                            );


                        if (
                            current_amount >
                            new_payable
                        ) {

                            input.val(
                                new_payable.toFixed(2)
                            );
                        }
                    }
                );


                update_bulk_payment_total(
                    dialog
                );


                frappe.show_alert({

                    message:
                        "Payment details recalculated.",

                    indicator:
                        "green"
                });
            }
    });
}


/* =========================================================
   SAVE SUPPLIER PAYMENT
   ========================================================= */

function save_supplier_payment(
    frm,
    dialog,
    data
) {

    const payments = [];

    let invalid = false;


    dialog.$wrapper
        .find(
            ".bulk-payment-amount"
        )
        .each(
            function () {

                const input =
                    $(this);

                const row_name =
                    input.attr(
                        "data-row-name"
                    );

                const payable =
                    flt(
                        input.attr(
                            "data-payable"
                        )
                    );

                const amount =
                    flt(
                        input.val()
                    );


                if (
                    amount < 0
                ) {

                    frappe.msgprint({

                        title:
                            "Invalid Amount",

                        message:
                            "Payment amount cannot be negative.",

                        indicator:
                            "red"
                    });

                    invalid = true;

                    return false;
                }


                if (
                    amount > payable
                ) {

                    frappe.msgprint({

                        title:
                            "Invalid Amount",

                        message:
                            `Payment amount cannot exceed ₹${payable.toFixed(2)}.`,

                        indicator:
                            "red"
                    });

                    invalid = true;

                    return false;
                }


                if (
                    amount <= 0
                ) {
                    return;
                }


                const invoice =
                    data.invoices.find(
                        item =>
                            item.name ===
                            row_name
                    );


                if (!invoice) {
                    return;
                }


                payments.push({

                    purchase_invoice_id:
                        invoice.purchase_invoice_id,

                    amount_paid:
                        amount
                });
            }
        );


    if (invalid) {
        return;
    }


    if (!payments.length) {

        frappe.msgprint({

            title:
                "Amount Required",

            message:
                "Enter an amount for at least one invoice.",

            indicator:
                "orange"
        });

        return;
    }


    frappe.call({

        method:
            "intial_app.api.bulk_payment.save_supplier_payment",

        args: {

            bulk_payment_name:
                frm.doc.name,

            supplier_name:
                data.supplier,

            payments:
                JSON.stringify(
                    payments
                )
        },

        freeze:
            true,

        freeze_message:
            "Saving payment details...",

        callback:
            function (r) {

                if (
                    !r.message ||
                    !r.message.success
                ) {

                    frappe.msgprint({

                        title:
                            "Payment Not Saved",

                        message:
                            get_server_error_message(
                                r,
                                "Payment validation failed."
                            ),

                        indicator:
                            "red"
                    });

                    return;
                }


                dialog.hide();

                frm.reload_doc();


                frappe.show_alert({

                    message:
                        "Payment amount saved successfully.",

                    indicator:
                        "green"
                });
            }
    });
}


/* =========================================================
   START BULK PAYMENT
   ========================================================= */

function start_bulk_payment(frm) {

    frappe.call({

        method:
            "intial_app.api.bulk_payment.get_bulk_payment_details",

        args: {

            bulk_payment_name:
                frm.doc.name
        },

        freeze:
            true,

        freeze_message:
            "Preparing Bulk Payment...",

        callback:
            function (r) {

                if (
                    !r.message ||
                    !r.message.success
                ) {

                    frappe.msgprint({

                        title:
                            "Payment Cannot Start",

                        message:
                            get_server_error_message(
                                r,
                                "Unable to prepare Bulk Payment."
                            ),

                        indicator:
                            "red"
                    });

                    return;
                }


                show_bulk_payment_authorization(
                    frm,
                    r.message
                );
            }
    });
}


/* =========================================================
   BULK PAYMENT AUTHORIZATION
   ========================================================= */

function show_bulk_payment_authorization(
    frm,
    data
) {

    let invoice_html = "";


    (
        data.invoices || []
    ).forEach(
        function (invoice) {

            invoice_html += `

                <tr>

                    <td>
                        ${invoice.purchase_invoice_id}
                    </td>

                    <td>
                        ${invoice.supplier}
                    </td>

                    <td>
                        ${invoice.receiver_account}
                    </td>

                    <td>
                        ₹${flt(
                            invoice.amount
                        ).toFixed(2)}
                    </td>

                </tr>
            `;
        }
    );


    const dialog =
        new frappe.ui.Dialog({

            title:
                "Bulk Payment Authorization",

            size:
                "large",

            fields: [

                {
                    fieldname:
                        "payment_summary",

                    fieldtype:
                        "HTML",

                    options: `

                        <div
                            style="margin-bottom:20px;"
                        >

                            <h4>
                                Payment Summary
                            </h4>

                            <div
                                class="table-responsive"
                            >

                                <table
                                    class="table table-bordered"
                                >

                                    <thead>

                                        <tr>

                                            <th>
                                                Purchase Invoice
                                            </th>

                                            <th>
                                                Supplier
                                            </th>

                                            <th>
                                                Receiver Account
                                            </th>

                                            <th>
                                                Amount
                                            </th>

                                        </tr>

                                    </thead>

                                    <tbody>

                                        ${invoice_html}

                                    </tbody>

                                </table>

                            </div>


                            <div
                                style="
                                    text-align:right;
                                    font-size:18px;
                                    margin-top:15px;
                                "
                            >

                                <strong>
                                    Total Amount:
                                    ₹${flt(
                                        data.total_amount
                                    ).toFixed(2)}
                                </strong>

                            </div>

                        </div>
                    `
                },


                {
                    fieldname:
                        "sender_account",

                    label:
                        "Sender Account",

                    fieldtype:
                        "Link",

                    options:
                        "Bank Account",

                    reqd:
                        1,

                    onchange:
                        function () {

                            const sender_account =
                                dialog.get_value(
                                    "sender_account"
                                );

                            if (!sender_account) {
                                return;
                            }

                            fetch_sender_mobile(
                                dialog,
                                sender_account
                            );
                        }
                },


                {
                    fieldname:
                        "mode_of_payment",

                    label:
                        "Mode of Payment",

                    fieldtype:
                        "Link",

                    options:
                        "Mode of Payment",

                    reqd:
                        1
                },


                {
                    fieldname:
                        "sender_mobile",

                    label:
                        "Sender Mobile",

                    fieldtype:
                        "Data",

                    read_only:
                        1,

                    reqd:
                        1
                }
            ],


            primary_action_label:
                "Request OTP",


            primary_action:
                function () {

                    const values =
                        dialog.get_values();

                    if (!values) {
                        return;
                    }


                    if (
                        !values.sender_account
                    ) {

                        frappe.msgprint(
                            "Please select Sender Account."
                        );

                        return;
                    }


                    if (
                        !values.mode_of_payment
                    ) {

                        frappe.msgprint(
                            "Please select Mode of Payment."
                        );

                        return;
                    }


                    if (
                        !values.sender_mobile
                    ) {

                        frappe.msgprint(
                            "Sender mobile is missing."
                        );

                        return;
                    }


                    request_bulk_otp(
                        frm,
                        dialog,
                        data
                    );
                }
        });


    dialog.show();
}


/* =========================================================
   FETCH SENDER MOBILE
   ========================================================= */

function fetch_sender_mobile(
    dialog,
    sender_account
) {

    frappe.db
        .get_value(
            "Bank Account",
            sender_account,
            "custom_mobile_number"
        )
        .then(
            function (r) {

                const mobile =
                    r.message?.custom_mobile_number;


                if (!mobile) {

                    dialog.set_value(
                        "sender_mobile",
                        ""
                    );


                    frappe.msgprint({

                        title:
                            "Mobile Number Missing",

                        message:
                            `Bank Account ${sender_account} does not have a mobile number.`,

                        indicator:
                            "orange"
                    });

                    return;
                }


                dialog.set_value(
                    "sender_mobile",
                    mobile
                );
            }
        );
}


/* =========================================================
   AUTHORIZATION VALIDATION
   ========================================================= */

function validate_authorization(
    frm,
    dialog,
    data
) {

    const values =
        dialog.get_values();

    if (!values) {
        return;
    }


    if (!values.sender_account) {

        frappe.msgprint({

            title:
                "Sender Account Required",

            message:
                "Please select Sender Account.",

            indicator:
                "orange"
        });

        return;
    }


    if (!values.mode_of_payment) {

        frappe.msgprint({

            title:
                "Mode of Payment Required",

            message:
                "Please select Mode of Payment.",

            indicator:
                "orange"
        });

        return;
    }


    if (!values.sender_mobile) {

        frappe.msgprint({

            title:
                "Mobile Number Missing",

            message:
                "Mobile number could not be fetched from the Sender Account.",

            indicator:
                "orange"
        });

        return;
    }


    frappe.show_alert({

        message:
            "Authorization details validated.",

        indicator:
            "green"
    });


    console.log(
        "Bulk Payment Authorization:",
        {
            sender_account:
                values.sender_account,

            mode_of_payment:
                values.mode_of_payment,

            sender_mobile:
                values.sender_mobile,

            total_amount:
                data.total_amount
        }
    );
}


/* =========================================================
   REQUEST OTP
   ========================================================= */

function request_bulk_otp(
    frm,
    authorization_dialog,
    data
) {

    const values =
        authorization_dialog.get_values();

    if (!values) {
        return;
    }


    if (!values.sender_account) {

        frappe.msgprint({

            title:
                "Sender Account Required",

            message:
                "Please select Sender Account.",

            indicator:
                "orange"
        });

        return;
    }


    if (!values.mode_of_payment) {

        frappe.msgprint({

            title:
                "Mode of Payment Required",

            message:
                "Please select Mode of Payment.",

            indicator:
                "orange"
        });

        return;
    }


    if (!values.sender_mobile) {

        frappe.msgprint({

            title:
                "Mobile Number Missing",

            message:
                "Sender mobile could not be fetched.",

            indicator:
                "orange"
        });

        return;
    }


    frappe.call({

        method:
            "intial_app.api.payment.request_otp",

        args: {

            mobile:
                values.sender_mobile
        },

        freeze:
            true,

        freeze_message:
            "Sending OTP...",

        callback:
            function (r) {

                if (
                    !r.message ||
                    !r.message.success
                ) {

                    frappe.msgprint({

                        title:
                            "OTP Failed",

                        message:
                            get_server_error_message(
                                r,
                                "Unable to send OTP."
                            ),

                        indicator:
                            "red"
                    });

                    return;
                }


                const otp_verification_id =
                    r.message.otp_verification_id;


                show_bulk_otp_dialog(
                    frm,
                    authorization_dialog,
                    data,
                    values,
                    otp_verification_id
                );
            }
    });
}


/* =========================================================
   OTP DIALOG
   ========================================================= */

function show_bulk_otp_dialog(
    frm,
    authorization_dialog,
    data,
    values,
    otp_verification_id
) {

    const otp_dialog =
        new frappe.ui.Dialog({

            title:
                "Verify Bulk Payment OTP",

            fields: [

                {
                    fieldname:
                        "otp_info",

                    fieldtype:
                        "HTML",

                    options: `

                        <div
                            style="margin-bottom:15px;"
                        >

                            <p>
                                OTP has been sent to:
                                <strong>
                                    ${values.sender_mobile}
                                </strong>
                            </p>

                            <p
                                style="margin-top:10px;"
                            >
                                This OTP authorizes all selected Purchase Invoice payments.
                            </p>

                        </div>
                    `
                },


                {
                    fieldname:
                        "otp",

                    label:
                        "OTP",

                    fieldtype:
                        "Data",

                    reqd:
                        1
                }
            ],


            primary_action_label:
                "Verify OTP",


            primary_action:
                function () {

                    verify_bulk_otp(
                        frm,
                        otp_dialog,
                        authorization_dialog,
                        data,
                        values,
                        otp_verification_id
                    );
                }
        });


    otp_dialog.show();
}


/* =========================================================
   VERIFY OTP
   ========================================================= */

function verify_bulk_otp(
    frm,
    otp_dialog,
    authorization_dialog,
    data,
    values,
    otp_verification_id
) {

    const otp =
        otp_dialog.get_value(
            "otp"
        );


    if (!otp) {

        frappe.msgprint({

            title:
                "OTP Required",

            message:
                "Please enter the OTP.",

            indicator:
                "orange"
        });

        return;
    }


    const invoices_payload =
        (data.invoices || [])
            .map(
                function (invoice) {

                    return {

                        invoice_id:
                            invoice.purchase_invoice_id,

                        amount:
                            invoice.amount,

                        receiver_bank_account:
                            invoice.receiver_bank_account,

                        receiver_account_number:
                            invoice.receiver_account,

                        sender_account:
                            values.sender_account,

                        mode_of_payment:
                            values.mode_of_payment
                    };
                }
            );


    if (
        !invoices_payload.length
    ) {

        frappe.msgprint({

            title:
                "No Payment",

            message:
                "No selected invoice payment was found.",

            indicator:
                "orange"
        });

        return;
    }


    frappe.call({

        method:
            "intial_app.api.payment.verify_bulk_otp",

        args: {

            otp_verification_id:
                otp_verification_id,

            otp:
                otp,

            invoices:
                JSON.stringify(
                    invoices_payload
                ),

            mobile:
                values.sender_mobile,

            bulk_payment_name:
                frm.doc.name
        },

        freeze:
            true,

        freeze_message:
            "Verifying OTP...",

        callback:
            function (r) {

                if (
                    !r.message ||
                    !r.message.success
                ) {

                    if (
                        r.message?.max_attempts
                    ) {

                        otp_dialog.hide();

                        authorization_dialog.hide();


                        frappe.msgprint({

                            title:
                                "OTP Verification Terminated",

                            message:
                                "Maximum 3 OTP attempts reached. Payment cancelled.",

                            indicator:
                                "red"
                        });

                    } else {

                        frappe.msgprint({

                            title:
                                "OTP Verification Failed",

                            message:
                                get_server_error_message(
                                    r,
                                    `Invalid OTP. Attempt ${r.message?.attempt_count || 0} of 3.`
                                ),

                            indicator:
                                "red"
                        });


                        otp_dialog.set_value(
                            "otp",
                            ""
                        );
                    }

                    return;
                }


                otp_dialog.hide();

                authorization_dialog.hide();


                frm.reload_doc()
                    .then(
                        function () {

                            frappe.msgprint({

                                message:
                                    "OTP verified successfully.",

                                indicator:
                                    "green"
                            });

                        }
                    );


                console.log(
                    "BEFORE SUBMIT - Supplier Details:",
                    frm.doc.supplier_details
                );
            }
    });
}