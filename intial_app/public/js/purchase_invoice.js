frappe.ui.form.on("Purchase Invoice", {
    refresh(frm) {
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
    console.log(mobile);
    
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
                frappe.call({
                    method: "intial_app.api.payment.save_otp_failure",
                    args: {
                        invoice_id: frm.doc.name,
                        ref_no: otp_verification_id,
                        error: response.message || "Invalid OTP",
                        otp_entered: otp,
                        mobile: mobile,
                        attempt_no: response.attempt_count || 0
                    },
                    callback: function () {
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
                    }
                });
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

    let dialog = new frappe.ui.Dialog({
        title: "Payment Amount",
        fields: [
            {
                fieldname: "amount",
                label: "Amount to Pay",
                fieldtype: "Currency",
                default: outstanding_amount,
                reqd: 1,
                description: `Outstanding Amount: ₹${outstanding_amount}`
            }
        ],
        primary_action_label: "Pay",
        primary_action(values) {
            let amount = flt(values.amount);

            if (amount <= 0) {
                frappe.msgprint("Amount must be greater than 0.");
                return;
            }

            if (amount > outstanding_amount) {
                frappe.msgprint(`You can pay maximum ₹${outstanding_amount}.`);
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

    console.log("THIS IS PROCSS ")
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
            if (!r.message) {
                frappe.msgprint("No response received from Middleware.");
                return;
            }

            store_payment_result(
                frm,
                r.message,
                amount,
                mobile,
                transaction_id,
                sender_account,
                mode_of_payment
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
    mode_of_payment
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
            mode_of_payment: mode_of_payment
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

            if (response.status === "SUCCESS") {
                frappe.msgprint({
                    title: "Payment Successful",
                    message: `<b>Payment Successful</b><br><br><b>Transaction ID:</b> ${result.transaction_id}<br><b>Installation No:</b> ${result.installation_no}<br><b>Amount:</b> ₹${amount}<br><b>Bank Reference:</b> ${result.bank_reference}<br><b>Payment Entry:</b> ${result.payment_entry || "Created"}`,
                    indicator: "green"
                });
            } else if (response.status === "PENDING") {
                frappe.msgprint({
                    title: "Payment Pending",
                    message: `Payment is pending bank confirmation.<br><b>Transaction ID:</b> ${result.transaction_id}`,
                    indicator: "orange"
                });
            } else {
                frappe.msgprint({
                    title: "Payment Failed",
                    message: `Payment failed.<br><b>Transaction ID:</b> ${result.transaction_id}<br><b>Reason:</b> ${result.failure_reason || response.reason || "Unknown error"}`,
                    indicator: "red"
                });
            }

            frm.reload_doc();
        }
    });
}