frappe.ui.form.on("Bulk Payment", {
    refresh(frm) {
        if (frm.is_new()) {
            return;
        }
        frm.add_custom_button("Recalculate", function () {
            recalculate_bulk_payment(frm);
        });
        frm.add_custom_button("Pay", function () {
            start_bulk_payment(frm);
        });
    }
});

frappe.ui.form.on("Supplier Details", {
    pay(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (!row.supplier_name) {
            frappe.msgprint({
                title: "Supplier Required",
                message: "Please select a Supplier first.",
                indicator: "orange"
            });
            return;
        }
        open_supplier_payment_popup(frm, row.supplier_name);
    }
});

function open_supplier_payment_popup(frm, supplier_name) {
    frappe.call({
        method: "intial_app.api.bulk_payment.get_supplier_invoices",
        args: {
            bulk_payment_name: frm.doc.name,
            supplier_name: supplier_name
        },
        freeze: true,
        freeze_message: "Loading Purchase Invoices...",
        callback: function (r) {
            if (!r.message || !r.message.success) {
                frappe.msgprint({
                    title: "Error",
                    message: r.message?.message || "Unable to load Purchase Invoices.",
                    indicator: "red"
                });
                return;
            }
            show_supplier_payment_popup(frm, r.message);
        }
    });
}

function show_supplier_payment_popup(frm, data) {
    let invoice_rows = "";
    (data.invoices || []).forEach(function (invoice) {
        invoice_rows += `
            <tr data-row-name="${invoice.name}">
                <td>${invoice.purchase_invoice_id}</td>
                <td>₹${flt(invoice.outstanding_amount).toFixed(2)}</td>
                <td>₹${flt(invoice.tax_amount).toFixed(2)}</td>
                <td>₹${flt(invoice.payable_amount).toFixed(2)}</td>
                <td>
                    <input
                        type="number"
                        class="form-control bulk-payment-amount"
                        data-row-name="${invoice.name}"
                        data-payable="${invoice.payable_amount}"
                        value="${flt(invoice.amount_paid)}"
                        min="0"
                        step="0.01"
                    >
                </td>
            </tr>
        `;
    });

    const dialog = new frappe.ui.Dialog({
        title: `Payment - ${data.supplier}`,
        size: "extra-large",
        fields: [
            {
                fieldname: "invoice_table",
                fieldtype: "HTML",
                options: `
                    <div style="margin-bottom:15px; display:flex; justify-content:space-between; align-items:center;">
                        <div><strong>Supplier:</strong> ${data.supplier}</div>
                        <button class="btn btn-default btn-sm" id="bulk-recalculate-btn">Recalculate</button>
                    </div>
                    <div class="table-responsive">
                        <table class="table table-bordered">
                            <thead>
                                <tr>
                                    <th>Purchase Invoice</th>
                                    <th>Outstanding</th>
                                    <th>Tax</th>
                                    <th>Payable</th>
                                    <th>Amount to Pay</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${invoice_rows}
                            </tbody>
                        </table>
                    </div>
                    <div style="margin-top:15px; text-align:right; font-size:16px;">
                        <strong>Total Payment: ₹<span class="bulk-total">0.00</span></strong>
                    </div>
                `
            }
        ],
        primary_action_label: "Save Payment",
        primary_action: function () {
            save_supplier_payment(frm, dialog, data);
        }
    });

    dialog.show();
    update_bulk_payment_total(dialog);

    dialog.$wrapper.on("input", ".bulk-payment-amount", function () {
        update_bulk_payment_total(dialog);
    });

    dialog.$wrapper.on("click", "#bulk-recalculate-btn", function () {
        recalculate_supplier_popup(frm, dialog, data.supplier);
    });
}

function update_bulk_payment_total(dialog) {
    let total = 0;
    dialog.$wrapper.find(".bulk-payment-amount").each(function () {
        total += flt($(this).val());
    });
    dialog.$wrapper.find(".bulk-total").text(total.toFixed(2));
}

function recalculate_supplier_popup(frm, dialog, supplier_name) {
    frappe.call({
        method: "intial_app.api.bulk_payment.get_supplier_invoices",
        args: {
            bulk_payment_name: frm.doc.name,
            supplier_name: supplier_name
        },
        freeze: true,
        freeze_message: "Getting latest Purchase Invoice amounts...",
        callback: function (r) {
            if (!r.message || !r.message.success) {
                frappe.msgprint({
                    title: "Recalculate Failed",
                    message: r.message?.message || "Could not refresh invoice amounts.",
                    indicator: "red"
                });
                return;
            }

            const invoices = r.message.invoices || [];
            invoices.forEach(function (invoice) {
                const input = dialog.$wrapper.find(`.bulk-payment-amount[data-row-name="${invoice.name}"]`);
                const row = dialog.$wrapper.find(`tr[data-row-name="${invoice.name}"]`);

                if (!row.length) return;

                row.find("td:nth-child(2)").text(`₹${flt(invoice.outstanding_amount).toFixed(2)}`);
                row.find("td:nth-child(3)").text(`₹${flt(invoice.tax_amount).toFixed(2)}`);
                row.find("td:nth-child(4)").text(`₹${flt(invoice.payable_amount).toFixed(2)}`);

                input.attr("data-payable", invoice.payable_amount);
                const current_amount = flt(input.val());
                if (current_amount > flt(invoice.payable_amount)) {
                    input.val(invoice.payable_amount);
                }
            });

            update_bulk_payment_total(dialog);
            frappe.show_alert({
                message: "Latest Purchase Invoice amounts loaded.",
                indicator: "green"
            });
        }
    });
}

function save_supplier_payment(frm, dialog, data) {
    const payments = [];
    let invalid = false;

    dialog.$wrapper.find(".bulk-payment-amount").each(function () {
        const input = $(this);
        const row_name = input.attr("data-row-name");
        const payable = flt(input.attr("data-payable"));
        const amount = flt(input.val());

        if (amount < 0) {
            frappe.msgprint({
                title: "Invalid Amount",
                message: "Payment amount cannot be negative.",
                indicator: "red"
            });
            invalid = true;
            return false;
        }

        if (amount > payable) {
            frappe.msgprint({
                title: "Invalid Amount",
                message: `Payment amount cannot exceed ₹${payable.toFixed(2)}.`,
                indicator: "red"
            });
            invalid = true;
            return false;
        }

        const invoice = data.invoices.find(item => item.name === row_name);
        if (!invoice) return;

        payments.push({
            row_name: row_name,
            purchase_invoice_id: invoice.purchase_invoice_id,
            amount_paid: amount
        });
    });

    if (invalid) return;

    if (!payments.some(row => row.amount_paid > 0)) {
        frappe.msgprint({
            title: "Amount Required",
            message: "Enter at least one payment amount.",
            indicator: "orange"
        });
        return;
    }

    frappe.call({
        method: "intial_app.api.bulk_payment.save_supplier_payment",
        args: {
            bulk_payment_name: frm.doc.name,
            supplier_name: data.supplier,
            payments: JSON.stringify(payments)
        },
        freeze: true,
        freeze_message: "Validating and saving payment...",
        callback: function (r) {
            if (!r.message || !r.message.success) {
                frappe.msgprint({
                    title: "Payment Not Saved",
                    message: r.message?.message || "Payment validation failed.",
                    indicator: "red"
                });
                return;
            }

            dialog.hide();
            frm.reload_doc();
            frappe.show_alert({
                message: "Bulk payment details saved successfully.",
                indicator: "green"
            });
        }
    });
}

function recalculate_bulk_payment(frm) {
    frappe.call({
        method: "intial_app.api.bulk_payment.recalculate_bulk_payment",
        args: { bulk_payment_name: frm.doc.name },
        freeze: true,
        freeze_message: "Recalculating latest Purchase Invoice amounts...",
        callback: function (r) {
            if (!r.message || !r.message.success) {
                frappe.msgprint({
                    title: "Recalculate Failed",
                    message: r.message?.message || "Unable to recalculate Bulk Payment.",
                    indicator: "red"
                });
                return;
            }

            frm.reload_doc();
            frappe.show_alert({
                message: "Bulk Payment amounts recalculated successfully.",
                indicator: "green"
            });
        }
    });
}

function start_bulk_payment(frm) {
    frappe.call({
        method: "intial_app.api.bulk_payment.get_bulk_payment_details",
        args: { bulk_payment_name: frm.doc.name },
        freeze: true,
        freeze_message: "Validating Bulk Payment...",
        callback: function (r) {
            if (!r.message || !r.message.success) {
                frappe.msgprint({
                    title: "Payment Cannot Start",
                    message: r.message?.message || "Bulk Payment validation failed.",
                    indicator: "red"
                });
                return;
            }
            show_bulk_payment_authorization(frm, r.message);
        }
    });
}

function show_bulk_payment_authorization(frm, data) {
    let invoice_html = "";
    (data.invoices || []).forEach(function (invoice) {
        invoice_html += `
            <tr>
                <td>${invoice.purchase_invoice_id}</td>
                <td>${invoice.supplier}</td>
                <td>${invoice.receiver_account}</td>
                <td>₹${flt(invoice.amount).toFixed(2)}</td>
            </tr>
        `;
    });

    const dialog = new frappe.ui.Dialog({
        title: "Bulk Payment Authorization",
        size: "extra-large",
        fields: [
            {
                fieldname: "payment_summary",
                fieldtype: "HTML",
                options: `
                    <div style="margin-bottom:20px;">
                        <h4>Payment Summary</h4>
                        <div class="table-responsive">
                            <table class="table table-bordered">
                                <thead>
                                    <tr>
                                        <th>Purchase Invoice</th>
                                        <th>Supplier</th>
                                        <th>Receiver Account</th>
                                        <th>Amount</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${invoice_html}
                                </tbody>
                            </table>
                        </div>
                        <div style="text-align:right; font-size:18px; margin-top:15px;">
                            <strong>Total Amount: ₹${flt(data.total_amount).toFixed(2)}</strong>
                        </div>
                    </div>
                `
            },
            {
                fieldname: "sender_account",
                label: "Sender Account",
                fieldtype: "Link",
                options: "Bank Account",
                reqd: 1
            },
            {
                fieldname: "mode_of_payment",
                label: "Mode of Payment",
                fieldtype: "Link",
                options: "Mode of Payment",
                reqd: 1
            },
            {
                fieldname: "sender_mobile",
                label: "Sender Mobile",
                fieldtype: "Data",
                reqd: 1
            }
        ],
        primary_action_label: "Request OTP",
        primary_action: function () {
            request_bulk_otp(frm, dialog, data);
        }
    });

    dialog.show();
}

function request_bulk_otp(frm, dialog, data) {
    const values = dialog.get_values();
    if (!values) return;

    if (!values.sender_account) {
        frappe.msgprint({
            title: "Sender Account Required",
            message: "Please select Sender Account.",
            indicator: "orange"
        });
        return;
    }

    if (!values.mode_of_payment) {
        frappe.msgprint({
            title: "Mode of Payment Required",
            message: "Please select Mode of Payment.",
            indicator: "orange"
        });
        return;
    }

    if (!values.sender_mobile) {
        frappe.msgprint({
            title: "Mobile Number Required",
            message: "Please enter Sender Mobile Number.",
            indicator: "orange"
        });
        return;
    }

    frappe.call({
        method: "intial_app.api.payment.request_otp",
        args: { mobile: values.sender_mobile },
        freeze: true,
        freeze_message: "Sending OTP...",
        callback: function (r) {
            if (!r.message || !r.message.success) {
                frappe.msgprint({
                    title: "OTP Failed",
                    message: r.message?.message || "Unable to send OTP.",
                    indicator: "red"
                });
                return;
            }

            const otp_verification_id = r.message.otp_verification_id;
            show_bulk_otp_dialog(frm, dialog, data, values, otp_verification_id);
        }
    });
}

function show_bulk_otp_dialog(frm, authorization_dialog, data, values, otp_verification_id) {
    const otp_dialog = new frappe.ui.Dialog({
        title: "Verify Bulk Payment OTP",
        fields: [
            {
                fieldname: "otp_info",
                fieldtype: "HTML",
                options: `
                    <div style="margin-bottom:15px;">
                        <p>OTP has been sent to: <strong>${values.sender_mobile}</strong></p>
                        <p style="margin-top:10px;">This OTP authorizes all selected Purchase Invoice payments.</p>
                    </div>
                `
            },
            {
                fieldname: "otp",
                label: "OTP",
                fieldtype: "Data",
                reqd: 1
            }
        ],
        primary_action_label: "Verify OTP",
        primary_action: function () {
            verify_bulk_otp(frm, otp_dialog, authorization_dialog, data, values, otp_verification_id);
        }
    });

    otp_dialog.show();
}

function verify_bulk_otp(frm, otp_dialog, authorization_dialog, data, values, otp_verification_id) {
    const otp = otp_dialog.get_value("otp");
    if (!otp) {
        frappe.msgprint({
            title: "OTP Required",
            message: "Please enter the OTP.",
            indicator: "orange"
        });
        return;
    }

    const invoices_payload = (data.invoices || []).map(inv => ({
        invoice_id: inv.purchase_invoice_id,
        amount: inv.amount,
        receiver_bank_account: inv.receiver_bank_account,
        receiver_account_number: inv.receiver_account,
        sender_account: values.sender_account,
        mode_of_payment: values.mode_of_payment
    }));

    frappe.call({
        method: "intial_app.api.payment.verify_bulk_otp",
        args: {
            otp_verification_id: otp_verification_id,
            otp: otp,
            invoices: JSON.stringify(invoices_payload),
            mobile: values.sender_mobile
        },
        freeze: true,
        freeze_message: "Verifying Bulk OTP...",
        callback: function (r) {
            if (!r.message || !r.message.success) {
                if (r.message?.max_attempts) {
                    otp_dialog.hide();
                    authorization_dialog.hide();
                    frappe.msgprint({
                        title: "OTP Verification Terminated",
                        message: "Maximum 3 OTP attempts reached. Payment cancelled.",
                        indicator: "red"
                    });
                } else {
                    frappe.msgprint({
                        title: "OTP Verification Failed",
                        message: `Invalid OTP. Attempt ${r.message?.attempt_count || 0} of 3.`,
                        indicator: "red"
                    });
                    otp_dialog.set_value("otp", "");
                }
                return;
            }

            otp_dialog.hide();
            authorization_dialog.hide();

            frappe.show_alert({
                message: "OTP verified successfully.",
                indicator: "green"
            });

            show_bulk_submit_confirmation(frm, data, values, otp_verification_id, r.message.transactions);
        }
    });
}

function show_bulk_submit_confirmation(frm, data, values, otp_verification_id, transactions) {
    let invoice_html = "";
    (data.invoices || []).forEach(function (invoice) {
        invoice_html += `
            <tr>
                <td>${invoice.purchase_invoice_id}</td>
                <td>${invoice.receiver_account}</td>
                <td>₹${flt(invoice.amount).toFixed(2)}</td>
            </tr>
        `;
    });

    const submit_dialog = new frappe.ui.Dialog({
        title: "Confirm Bulk Payment",
        size: "large",
        fields: [
            {
                fieldname: "confirmation",
                fieldtype: "HTML",
                options: `
                    <div>
                        <div class="alert alert-success">
                            <strong>OTP Verified</strong><br>
                            Payment authorization successful.
                        </div>
                        <p><strong>Sender Account:</strong> ${values.sender_account}</p>
                        <p><strong>Mode of Payment:</strong> ${values.mode_of_payment}</p>
                        <table class="table table-bordered">
                            <thead>
                                <tr>
                                    <th>Purchase Invoice</th>
                                    <th>Receiver Account</th>
                                    <th>Amount</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${invoice_html}
                            </tbody>
                        </table>
                        <div style="text-align:right; font-size:18px;">
                            <strong>Total: ₹${flt(data.total_amount).toFixed(2)}</strong>
                        </div>
                    </div>
                `
            }
        ],
        primary_action_label: "Submit Payment",
        primary_action: function () {
            submit_bulk_payment(frm, submit_dialog, data, values, otp_verification_id, transactions);
        }
    });

    submit_dialog.show();
}

function submit_bulk_payment(frm, dialog, data, values, otp_verification_id, transactions) {
    frappe.confirm(
        `Are you sure you want to submit this bulk payment of ₹${flt(data.total_amount).toFixed(2)}?`,
        function () {
            frappe.call({
                method: "intial_app.api.bulk_payment.submit_bulk_payment",
                args: {
                    bulk_payment_name: frm.doc.name,
                    otp_verification_id: otp_verification_id,
                    sender_account: values.sender_account,
                    mode_of_payment: values.mode_of_payment,
                    sender_mobile: values.sender_mobile,
                    transactions: JSON.stringify(transactions)
                },
                freeze: true,
                freeze_message: "Submitting Bulk Payment...",
                callback: function (r) {
                    if (!r.message || !r.message.success) {
                        frappe.msgprint({
                            title: "Bulk Payment Failed",
                            message: r.message?.message || "Bulk payment could not be submitted.",
                            indicator: "red"
                        });
                        return;
                    }
                    dialog.hide();
                    show_bulk_payment_result(frm, r.message);
                }
            });
        }
    );
}

function show_bulk_payment_result(frm, response) {
    let html = "";
    (response.results || []).forEach(function (result) {
        let indicator = "blue";
        if (result.status === "SUCCESS") {
            indicator = "green";
        } else if (result.status === "PENDING") {
            indicator = "orange";
        } else if (result.status === "FAILED") {
            indicator = "red";
        }
        html += `
            <tr>
                <td>${result.purchase_invoice_id}</td>
                <td>${result.transaction_id}</td>
                <td>${result.installation_no}</td>
                <td>₹${flt(result.amount).toFixed(2)}</td>
                <td><span class="indicator ${indicator}">${result.status || "UNKNOWN"}</span></td>
            </tr>
        `;
    });

    const dialog = new frappe.ui.Dialog({
        title: "Bulk Payment Result",
        size: "extra-large",
        fields: [
            {
                fieldname: "result",
                fieldtype: "HTML",
                options: `
                    <div>
                        <table class="table table-bordered">
                            <thead>
                                <tr>
                                    <th>Purchase Invoice</th>
                                    <th>Transaction ID</th>
                                    <th>Installation</th>
                                    <th>Amount</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${html}
                            </tbody>
                        </table>
                    </div>
                `
            }
        ],
        primary_action_label: "Close",
        primary_action: function () {
            dialog.hide();
            frm.reload_doc();
        }
    });

    dialog.show();
}