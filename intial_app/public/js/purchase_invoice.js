frappe.ui.form.on("Purchase Invoice", {

    refresh(frm) {

        if (frm.is_new()) {
            return;
        }

         if (flt(frm.doc.outstanding_amount) <= 0) {
            return;
        }

         let payment_in_progress = false;

        (frm.doc.custom_install || []).forEach(row => {

            if (
                row.payment_status === "Pending" ||
                row.payment_status === "Processing"
            ) {
                payment_in_progress = true;
            }

        });

         if (payment_in_progress) {
            return;
        }

         frm.add_custom_button(
            "Make Payment",
            function () {
                show_payment_dialog(frm);
            }
        );
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
    frappe.db.get_value(
        "Bank Account",
        sender_account,
        "custom_mobile_number"
    ).then(r => {
        let mobile = r.message ? r.message.custom_mobile_number : null;

        if (!mobile) {
            frappe.msgprint("Mobile number is not configured for this Sender Bank Account.");
            return;
        }

        console.log("Sender:", sender_account);
        console.log("Mobile:", mobile);

        request_payment_otp(
            frm,
            receiver_bank_account,
            mode_of_payment,
            sender_account,
            mobile
        );
    });
}

function request_payment_otp(
    frm,
    receiver_bank_account,
    mode_of_payment,
    sender_account,
    mobile
) {
    frappe.call({
        method: "intial_app.api.payment.request_otp",
        args: {
            mobile: mobile
        },
        freeze: true,
        freeze_message: "Sending OTP...",
        callback: function(r) {
            if (!r.message || !r.message.success) {
                frappe.msgprint(
                    r.message?.message || "Unable to send OTP."
                );
                return;
            }

            let transaction_id = r.message.transaction_id;
            let otp_verification_id = r.message.otp_verification_id;

            console.log("Transaction ID:", transaction_id);
            console.log("OTP Verification ID:", otp_verification_id);

            show_otp_dialog(
                frm,
                receiver_bank_account,
                mode_of_payment,
                sender_account,
                mobile,
                transaction_id,
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
    transaction_id,
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
                transaction_id,
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
    transaction_id,
    otp_verification_id,
    otp,
    dialog
) {
    frappe.call({
        method: "intial_app.api.payment.verify_otp",
        args: {
            transaction_id: transaction_id,
            otp_verification_id: otp_verification_id,
            otp: otp,
            invoice_id: frm.doc.name,
            mobile: mobile
        },
        freeze: true,
        freeze_message: "Verifying OTP...",
        callback: function(r) {
            if (!r.message) {
                frappe.msgprint("No response from Middleware.");
                return;
            }

            let response = r.message;

        
        
      if (!response.success) {

        frappe.call({
            method:
                "intial_app.api.payment.save_otp_failure",

            args: {
                invoice_id: frm.doc.name,
                transaction_id: transaction_id,
                error: response.message,
                otp_entered: otp,
                mobile: mobile,
                attempt_no: response.attempt_count
            },

            callback: function(r) {

                console.log(
                    "OTP failure saved:",
                    r.message
                );

                if (response.max_attempts) {

                    dialog.hide();

                    frappe.msgprint(
                        "Maximum 3 OTP attempts reached."
                    );

                } else {

                    frappe.msgprint(
                        `Invalid OTP. Attempt ${response.attempt_count} of 3.`
                    );

                    dialog.set_value("otp", "");
                }
            }
        });

        return;
    }

             
            if (response.success) {
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
                    transaction_id
                );
                return;
            }

          
            if (response.attempt_no >= 3) {
                dialog.hide();

                frappe.msgprint({
                    title: "OTP Failed",
                    message: "Maximum 3 OTP attempts reached. Payment stopped.",
                    indicator: "red"
                });
                return;
            }

        }
    });
}

function show_payment_amount_dialog(
    frm,
    receiver_bank_account,
    mode_of_payment,
    sender_account,
    mobile,
    transaction_id
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

           create_processing_installation(
    frm,
    amount,
    mobile,
    transaction_id
);

frm.save()
    .then(() => {

        console.log(
            "Processing payment saved:",
            transaction_id
        );

        process_payment(
            frm,
            receiver_bank_account,
            mode_of_payment,
            sender_account,
            mobile,
            transaction_id,
            amount
        );

    })
    .catch(error => {

        console.error(
            "Failed to save Processing payment:",
            error
        );

        frappe.msgprint({
            title: "Payment Error",
            message:
                "Could not save the Processing payment.",
            indicator: "red"
        });

    })
        }
    });

    dialog.show();
}
function create_processing_installation(
    frm,
    amount,
    mobile,
    transaction_id
) {

    let existing_numbers =
        (frm.doc.custom_install || [])
        .map(row => flt(row.installation_no || 0));

    let installation_no =
        Math.max(0, ...existing_numbers) + 1;

    let ref_no =
        `${frm.doc.name}-${installation_no}`;

    let row = frm.add_child(
        "custom_install"
    );

    row.installation_no =
        installation_no;

    row.ref_no =
        ref_no;

    row.amount =
        amount;

    row.mobile =
        mobile;

    row.otp_status =
        "Verified";

    row.transaction_id =
        transaction_id;

    row.payment_status =
        "Processing";

    frm.refresh_field(
        "custom_install"
    );

    return row;
}
function process_payment(
    frm,
    receiver_bank_account,
    mode_of_payment,
    sender_account,
    mobile,
    transaction_id,
    amount
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
            sender_account: sender_account
        },
        freeze: true,
        freeze_message: "Processing payment...",
        callback: function(r) {
            if (!r.message) {
                frappe.msgprint("No response received from Middleware.");
                return;
            }

            let response = r.message;

            console.log("Payment response:", response);

            store_payment_result(
                frm,
                response,
                amount,
                mobile,
                transaction_id
            );
        }
    });
}

function store_payment_result(
    frm,
    response,
    amount,
    mobile,
    transaction_id
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
            failure_reason: response.reason
        },
        callback: function(r) {
            if (!r.message || !r.message.success) {
                frappe.msgprint({
                    title: "Payment Result Error",
                    message: "Payment was processed, but the result could not be stored in the Purchase Invoice.",
                    indicator: "red"
                });
                return;
            }

            let result = r.message;

            if (response.status === "SUCCESS") {
                frappe.msgprint({
                    title: "Payment Successful",
                    message: `
                        <b>Payment Successful</b><br><br>
                        Transaction ID: ${result.transaction_id}<br>
                        Installation No: ${result.installation_no}<br>
                        Amount: ₹${amount}<br>
                        Bank Reference: ${result.bank_reference}
                    `,
                    indicator: "green"
                });
            } else {
                frappe.msgprint({
                    title: "Payment Failed",
                    message: `
                        Payment failed.<br><br>
                        Transaction ID: ${result.transaction_id}<br>
                        Reason: ${response.reason || "Unknown error"}
                    `,
                    indicator: "red"
                });
            }

            frm.reload_doc();
        }
    });
}