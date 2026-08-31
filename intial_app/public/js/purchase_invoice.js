frappe.ui.form.on("Purchase Invoice", {
    refresh(frm) {
        hide_tax_decision_buttons(frm);

         if (frm.doc.docstatus !== 1) {
            return;
        }

         if (!frm.doc.custom_tax_hold) {
            return;
        }

          set_tax_status_permission(frm);

        if (frm.is_new() || flt(frm.doc.outstanding_amount) <= 0) {
            return;
        }

        let payment_in_progress = (frm.doc.custom_install || []).some(row =>
            row.payment_status === "Pending" || row.payment_status === "Processing"
        );

        if (payment_in_progress) {
            return;
        }


        frm.add_custom_button("Make Payment", function () {
            show_payment_dialog(frm);
        });
    }
});

function show_payment_dialog(frm) {
    let dialog = new frappe.ui.Dialog({
        title: "Make Payment",
        fields: [
            {
                fieldname: "bank_account",
                label: "Receiver Bank Account",
                fieldtype: "Link",
                options: "Bank Account",
                reqd: 1
            }
        ],
        primary_action_label: "Continue",
        primary_action(values) {
            let bank_account = values.bank_account;
            dialog.hide();
            show_mode_of_payment_dialog(frm, bank_account);
        }
    });
    dialog.show();
}

function show_mode_of_payment_dialog(frm, receiver_bank_account) {
    let dialog = new frappe.ui.Dialog({
        title: "Payment Details",
        fields: [
            {
                fieldname: "mode_of_payment",
                label: "Mode of Payment",
                fieldtype: "Link",
                options: "Mode of Payment",
                reqd: 1
            }
        ],
        primary_action_label: "Continue",
        primary_action(values) {
            let mode_of_payment = values.mode_of_payment;
            dialog.hide();
            show_sender_account_dialog(frm, receiver_bank_account, mode_of_payment);
        }
    });
    dialog.show();
}

function show_sender_account_dialog(frm, receiver_bank_account, mode_of_payment) {
    let dialog = new frappe.ui.Dialog({
        title: "Sender Account",
        fields: [
            {
                fieldname: "sender_account",
                label: "Sender Bank Account",
                fieldtype: "Link",
                options: "Bank Account",
                reqd: 1
            }
        ],
        primary_action_label: "Continue",
        primary_action(values) {
            let sender_account = values.sender_account;
            dialog.hide();
            get_sender_mobile(frm, receiver_bank_account, mode_of_payment, sender_account);
        }
    });
    dialog.show();
}

function get_sender_mobile(frm, receiver_bank_account, mode_of_payment, sender_account) {
    frappe.db.get_value("Bank Account", sender_account, "custom_mobile_number").then(r => {
        let mobile = r.message ? r.message.custom_mobile_number : null;

        if (!mobile) {
            frappe.msgprint("Mobile number is not configured for this Sender Bank Account.");
            return;
        }

        request_payment_otp(frm, receiver_bank_account, mode_of_payment, sender_account, mobile);
    });
}

function request_payment_otp(frm, receiver_bank_account, mode_of_payment, sender_account, mobile) {
    frappe.call({
        method: "intial_app.api.payment.request_otp",
        args: { mobile: mobile },
        freeze: true,
        freeze_message: "Sending OTP...",
        callback: function (r) {
            if (!r.message || !r.message.success) {
                frappe.msgprint(r.message?.message || "Unable to send OTP.");
                return;
            }

            let otp_verification_id = r.message.otp_verification_id;
            show_otp_dialog(
                frm,
                receiver_bank_account,
                mode_of_payment,
                sender_account,
                mobile,
                otp_verification_id
            );
        }
    });
}

function show_otp_dialog(
    frm,
    receiver_bank_account,
    mode_of_payment,
    sender_account,
    mobile,
    otp_verification_id
) {
    let dialog = new frappe.ui.Dialog({
        title: "OTP Verification",
        fields: [
            {
                fieldname: "otp",
                label: "Enter OTP",
                fieldtype: "Data",
                reqd: 1
            }
        ],
        primary_action_label: "Verify",
        primary_action(values) {
            verify_payment_otp(
                frm,
                receiver_bank_account,
                mode_of_payment,
                sender_account,
                mobile,
                otp_verification_id,
                values.otp,
                dialog
            );
        }
    });
    dialog.show();
}

function verify_payment_otp(
    frm,
    receiver_bank_account,
    mode_of_payment,
    sender_account,
    mobile,
    otp_verification_id,
    otp,
    dialog
) {
    frappe.call({
        method: "intial_app.api.payment.verify_otp",
        args: {
            otp_verification_id: otp_verification_id,
            otp: otp,
            invoice_id: frm.doc.name,
            mobile: mobile,
            receiver_bank_account: receiver_bank_account,
            mode_of_payment: mode_of_payment,
            sender_account: sender_account
        },
        freeze: true,
        freeze_message: "Verifying OTP...",
        callback: function (r) {
            if (!r.message) {
                frappe.msgprint("No response from Middleware.");
                return;
            }

            let response = r.message;

            if (!response.success) {
                if (response.max_attempts) {
                    dialog.hide();
                    frappe.msgprint({
                        title: "OTP Verification Terminated",
                        message: "Maximum 3 OTP attempts reached. Payment cancelled.",
                        indicator: "red"
                    });
                } else {
                    frappe.msgprint(`Invalid OTP. Attempt ${response.attempt_count || 0} of 3.`);
                    dialog.set_value("otp", "");
                }
                return;
            }

            dialog.hide();
            frappe.msgprint({
                title: "OTP Verified",
                message: "OTP verified successfully.",
                indicator: "green"
            });

            show_payment_amount_dialog(
                frm,
                receiver_bank_account,
                mode_of_payment,
                sender_account,
                mobile,
                response.transaction_id,
                otp_verification_id
            );
        }
    });
}

function show_payment_amount_dialog(
    frm,
    receiver_bank_account,
    mode_of_payment,
    sender_account,
    mobile,
    transaction_id,
    otp_verification_id
) {
    let outstanding_amount = flt(frm.doc.outstanding_amount);
    let tax_amount = flt(frm.doc.taxes_and_charges_added);

    let tax_hold = frm.doc.custom_tax_hold;

    let payable_amount;

    if (tax_hold) {
        payable_amount = outstanding_amount - tax_amount;
    } else {
        payable_amount = outstanding_amount;
    }
    payable_amount = Math.max(payable_amount, 0);

    let dialog = new frappe.ui.Dialog({
        title: "Payment Amount",
        fields: [
            {
                fieldname: "outstanding_display",
                fieldtype: "HTML",
                options: `
                    <div style="margin-bottom: 15px;">
                        <div><strong>Outstanding Amount:</strong> ₹${outstanding_amount.toFixed(2)}</div>
                        <div><strong>Tax Amount:</strong> ₹${tax_amount.toFixed(2)}</div>
                       <div>
                        <strong>Tax Hold:</strong>${tax_hold ? "Accepted" : "Rejected"} </div>
                        <hr>
                        <div style="font-size: 16px;"><strong>Payable Amount:</strong> ₹${payable_amount.toFixed(2)}</div>
                    </div>
                `
            },
            {
                fieldname: "amount",
                label: "Amount to Pay",
                fieldtype: "Currency",
                default: payable_amount,
                reqd: 1
            }
        ],
        primary_action_label: "Pay",
        primary_action(values) {
            let amount = flt(values.amount);

            if (amount <= 0) {
                frappe.msgprint("Amount must be greater than 0.");
                return;
            }

            if (amount > payable_amount) {
                frappe.msgprint(`You can pay maximum ₹${payable_amount.toFixed(2)}.`);
                return;
            }

            dialog.hide();

            frappe.call({
                method: "intial_app.api.payment.create_processing_payment",
                args: {
                    invoice_id: frm.doc.name,
                    amount: amount,
                    mobile: mobile,
                    transaction_id: transaction_id,
                    sender_account: sender_account,
                    mode_of_payment: mode_of_payment,
                    otp_verification_id: otp_verification_id
                },
                freeze: true,
                freeze_message: "Creating Processing payment...",
                callback: function (r) {
                    if (!r.message || !r.message.success) {
                        frappe.msgprint({
                            title: "Payment Error",
                            message: r.message?.message || "Could not create Processing payment.",
                            indicator: "red"
                        });
                        return;
                    }

                    process_payment(
                        frm,
                        receiver_bank_account,
                        mode_of_payment,
                        sender_account,
                        mobile,
                        transaction_id,
                        amount,
                        r.message.installation_no
                    );
                }
            });
        }
    });

    dialog.show();
}

function process_payment(
    frm,
    receiver_bank_account,
    mode_of_payment,
    sender_account,
    mobile,
    transaction_id,
    amount,
    install_no
) {
    frappe.call({
        method: "intial_app.api.payment.process_payment",
        args: {
            transaction_id: transaction_id,
            amount: amount,
            invoice_id: frm.doc.name,
            mobile: mobile,
            receiver_bank_account: receiver_bank_account,
            mode_of_payment: mode_of_payment,
            sender_account: sender_account,
            install_no: install_no
        },
        freeze: true,
        freeze_message: "Processing payment...",
        callback: function (r) {
                console.log(r.message);
            if (!r.message) {
                frappe.msgprint("No response received from Middleware.");
                return;
            }
            console.log(r.message);
            

            store_payment_result(
                frm,
                r.message,
                amount,
                mobile,
                transaction_id,
                sender_account,
                mode_of_payment,
                install_no
            );
        }
    });
}

function store_payment_result(
    frm,
    response,
    amount,
    mobile,
    transaction_id,
    sender_account,
    mode_of_payment,
    install_no
) {
    frappe.call({
        method: "intial_app.api.payment.save_payment_result",
        args: {
            invoice_id: frm.doc.name,
            transaction_id: transaction_id,
            amount: amount,
            mobile: mobile,
            status: response.status,
            bank_reference: response.bank_reference,
            failure_reason: response.reason,
            sender_account: sender_account,
            mode_of_payment: mode_of_payment,
            install_no: install_no
        },
        callback: function (r) {
            if (!r.message || !r.message.success) {
                frappe.msgprint({
                    title: "Payment Result Error",
                    message: r.message?.message || "Payment processed, but saving result failed.",
                    indicator: "red"
                });
                return;
            }

            let result = r.message;

                    const payment_status = String(
                response.payment_status || response.status || ""
            ).toUpperCase();
            console.log(payment_status);
            

            if (payment_status === "SUCCESS" || payment_status === "COMPLETED") {

                frappe.msgprint({
                    title: "Payment Successful",
                    message: `
                        <b>Payment Successful</b><br><br>
                        <b>Transaction ID:</b> ${result.transaction_id}<br>
                        <b>Installation No:</b> ${install_no}<br>
                        <b>Amount:</b> ₹${amount}<br>
                        <b>Bank Reference:</b> ${result.bank_reference || "N/A"}<br>
                        <b>Payment Entry:</b> ${result.payment_entry || "Created"}
                    `,
                    indicator: "green"
                });

            } else if (
                payment_status === "PENDING" ||
                payment_status === "INITIATED"
            ) {

                frappe.msgprint({
                    title: "Payment Pending",
                    message: `
                        Payment has been initiated and is waiting for bank confirmation.<br>
                        <b>Transaction ID:</b> ${result.transaction_id}
                    `,
                    indicator: "orange"
                });

            } else if (
                payment_status === "FAILED" ||
                payment_status === "REJECTED" ||
                payment_status === "ERROR" ||
                payment_status === "FAILURE"
            ) {

                frappe.msgprint({
                    title: "Payment Failed",
                    message: `
                        Payment failed.<br>
                        <b>Transaction ID:</b> ${result.transaction_id}<br>
                        <b>Reason:</b> ${
                            result.failure_reason ||
                            response.reason ||
                            "Unknown error"
                        }
                    `,
                    indicator: "red"
                });

            } else {

                frappe.msgprint({
                    title: "Payment Status",
                    message: `
                        Payment status: ${payment_status || "UNKNOWN"}<br>
                        <b>Transaction ID:</b> ${result.transaction_id}
                    `,
                    indicator: "orange"
                });
            }

            frm.reload_doc();
        }
    });
}

function set_tax_status_permission(frm) {

    frappe.call({

        method: "intial_app.api.purchase_invoice.check_tax_permission",

        callback: function (r) {

            const allowed = r.message?.allowed || false;

            frm.__tax_permission = allowed;

            if (!allowed) {
                hide_tax_decision_buttons(frm);
                return;
            }

          
            if (frm.doc.custom_tax_hold) {
                add_tax_decision_buttons(frm);
            } else {
                hide_tax_decision_buttons(frm);
            }
        }
    });
}


function add_tax_decision_buttons(frm) {

     hide_tax_decision_buttons(frm);

    frm.add_custom_button(
        "Accept",
        function () {

            make_tax_decision(
                frm,
                "Accept"
            );

        },
        "Tax"
    );


    frm.add_custom_button(
        "Reject",
        function () {

            make_tax_decision(
                frm,
                "Reject"
            );

        },
        "Tax"
    );
}


function hide_tax_decision_buttons(frm) {

    frm.remove_custom_button(
        "Accept",
        "Tax"
    );

    frm.remove_custom_button(
        "Reject",
        "Tax"
    );
}

function make_tax_decision(frm, decision) {

    frappe.confirm(
        `Are you sure you want to ${decision} this Purchase Invoice?`,

        function () {

            frappe.call({

                method:
                    "intial_app.api.purchase_invoice.update_tax_status",

                args: {
                    invoice_name: frm.doc.name,
                    decision: decision
                },

                freeze: true,

                freeze_message: "Saving Tax Decision...",

                callback: function (r) {

                    if (
                        !r.message ||
                        !r.message.success
                    ) {

                        frappe.msgprint({
                            title: "Error",
                            message:
                                "Could not save Tax Decision.",
                            indicator: "red"
                        });

                        return;
                    }
 
                    frm.doc.custom_tax_hold =
                        r.message.custom_tax_hold;

                    frm.refresh_field(
                        "custom_tax_hold"
                    );

                   
                    hide_tax_decision_buttons(frm);
 
                    frappe.show_alert({
                        message:
                            r.message.message ||
                            `Tax ${decision}ed successfully.`,

                        indicator:
                            decision === "Accept"
                                ? "green"
                                : "red"
                    });
                }
            });
        },

        function () {

            frappe.show_alert({
                message:
                    "Tax decision was not changed.",
                indicator: "orange"
            });
        }
    );
}