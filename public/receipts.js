// Receipt photos, kept against an expense. Shared by the entry page, which
// takes photos with a new expense, and both expense lists, whose rows carry a
// button to add one or look at what is there.
//
// Classic script: load it after auth.js and helpers.js and before the page's
// own script. The page defines receiptsChanged(expenseId, count), called after
// a receipt is added or removed so the row can redraw its button.

const RECEIPT_MAX_BYTES = 25 * 1024 * 1024;   // the server's limit too
// The copy is what the viewer shows and what will be read for text. Its long
// edge keeps the small print on a long receipt legible, and the size cap is
// what Azure's free tier will read.
const RECEIPT_VIEW_EDGE = 3000;
const RECEIPT_VIEW_MAX_BYTES = 4 * 1024 * 1024;

// Some phones hand over a file with no type; its name usually says.
const RECEIPT_TYPES = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic',
    heif: 'image/heif', webp: 'image/webp', gif: 'image/gif'
};

let receiptPickerFor = null;    // the expense the row picker is adding to
let receiptViewerFor = null;    // the expense the viewer is showing

function receiptMime(file) {
    if (file.type) return file.type;
    const extension = (file.name || '').split('.').pop().toLowerCase();
    return RECEIPT_TYPES[extension] || '';
}

// Scaled so the long edge is at most RECEIPT_VIEW_EDGE. Never enlarged.
function receiptViewSize(width, height) {
    const scale = Math.min(1, RECEIPT_VIEW_EDGE / Math.max(width, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

// The viewing copy, a JPEG. Drawn through an <img>, which turns the photo the
// way the camera held it and decodes HEIC where the browser can.
async function receiptViewCopy(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('Not a photo this browser can open'));
            el.src = url;
        });
        const size = receiptViewSize(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext('2d');
        // A transparent screenshot would otherwise turn black as a JPEG.
        context.fillStyle = '#fff';
        context.fillRect(0, 0, size.width, size.height);
        context.drawImage(img, 0, 0, size.width, size.height);
        for (const quality of [0.85, 0.7, 0.55]) {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
            if (blob && blob.size <= RECEIPT_VIEW_MAX_BYTES) return blob;
        }
        throw new Error('Photo is too large');
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function receiptApi(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Error ${response.status}`);
    return result;
}

async function putReceiptFile(url, body, type) {
    const response = await fetch(url, { method: 'PUT', body, headers: { 'Content-Type': type } });
    if (!response.ok) throw new Error(`Upload failed (${response.status})`);
}

// One photo: the copy made, both files sent to the bucket, then recorded. The
// original goes up exactly as the phone handed it over.
async function uploadReceipt(expenseId, file) {
    if (file.size > RECEIPT_MAX_BYTES) throw new Error('Photo is over 25 MB');
    const mime = receiptMime(file);
    const view = await receiptViewCopy(file);
    const upload = await receiptApi(`/api/expenses/${expenseId}/receipts/upload`, {
        method: 'POST',
        body: JSON.stringify({ mime })
    });
    await putReceiptFile(upload.original_url, file, mime);
    await putReceiptFile(upload.view_url, view, 'image/jpeg');
    await receiptApi(`/api/expenses/${expenseId}/receipts`, {
        method: 'POST',
        body: JSON.stringify({ key: upload.key })
    });
}

// One at a time, so a slow phone connection is not split several ways.
// Returns the error message of each photo that did not save.
async function uploadReceipts(expenseId, files) {
    const errors = [];
    for (const file of files) {
        try {
            await uploadReceipt(expenseId, file);
        } catch (error) {
            errors.push(error.message);
        }
    }
    return errors;
}

async function loadReceipts(expenseId) {
    return receiptApi(`/api/expenses/${expenseId}/receipts`);
}

// The button at the end of an expense's row: 📎 to add a receipt, 🧾 to see
// them. A consolidated row on the Expenses page stands for several expenses
// and carries a made-up negative id, so it gets none.
function receiptButtonHtml(expense, className) {
    if (!(expense.id > 0)) return '';
    const count = Number(expense.receipt_count) || 0;
    const label = count === 0 ? '📎' : count === 1 ? '🧾' : `🧾${count}`;
    const action = count === 0 ? 'attachReceipt' : 'openReceipts';
    return `<button type="button" class="${className}" data-receipt-for="${expense.id}" aria-label="Receipt" onclick="${action}(${expense.id})">${label}</button>`;
}

function deleteExpenseQuestion(receiptCount) {
    if (!receiptCount) return 'Are you sure you want to delete this expense?';
    return `Delete this expense and its receipt${receiptCount > 1 ? 's' : ''}?`;
}

function receiptListHtml(receipts) {
    if (!receipts.length) return '<p class="empty-note">No receipts yet.</p>';
    return receipts.map(receipt => `
        <figure class="receipt-figure">
            <a href="${escapeHtml(receipt.view_url)}" target="_blank" rel="noopener">
                <img src="${escapeHtml(receipt.view_url)}" alt="Receipt">
            </a>
            <figcaption>
                <span>${new Date(receipt.uploaded_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                <a href="${escapeHtml(receipt.original_url)}" target="_blank" rel="noopener" class="small-btn">Original</a>
                <button type="button" class="small-btn" data-remove-receipt="${receipt.id}">Remove</button>
            </figcaption>
        </figure>`).join('');
}

function attachReceipt(expenseId) {
    receiptPickerFor = expenseId;
    const input = document.getElementById('receipt-row-input');
    input.value = '';
    input.click();
}

async function openReceipts(expenseId) {
    receiptViewerFor = expenseId;
    const list = document.getElementById('receipt-list');
    list.innerHTML = '<p class="empty-note">Loading…</p>';
    document.getElementById('receipt-modal').style.display = 'block';
    try {
        list.innerHTML = receiptListHtml(await loadReceipts(expenseId));
    } catch (error) {
        list.innerHTML = `<p class="empty-note">${escapeHtml(error.message)}</p>`;
    }
}

// After a change, the row's button and an open viewer both catch up.
async function refreshReceipts(expenseId) {
    const receipts = await loadReceipts(expenseId);
    if (typeof receiptsChanged === 'function') receiptsChanged(expenseId, receipts.length);
    const modal = document.getElementById('receipt-modal');
    if (receiptViewerFor === expenseId && modal.style.display === 'block') {
        document.getElementById('receipt-list').innerHTML = receiptListHtml(receipts);
    }
}

async function handleRowReceiptPick(e) {
    const files = [...e.target.files];
    const expenseId = receiptPickerFor;
    if (!files.length || !expenseId) return;
    const rowButtons = [...document.querySelectorAll(`[data-receipt-for="${expenseId}"]`)];
    const labels = rowButtons.map(button => button.textContent);
    rowButtons.forEach(button => {
        button.disabled = true;
        button.textContent = '⏳';
    });
    const addButton = document.getElementById('receipt-add-btn');
    addButton.disabled = true;
    const errors = await uploadReceipts(expenseId, files);
    addButton.disabled = false;
    try {
        await refreshReceipts(expenseId);
    } catch (error) {
        // The page did not redraw the row, so its button is put back as it was.
        rowButtons.forEach((button, i) => {
            button.disabled = false;
            button.textContent = labels[i];
        });
        errors.push(error.message);
    }
    if (errors.length) alert(`Receipt not saved: ${errors[0]}`);
}

async function handleReceiptRemove(e) {
    const id = e.target.dataset && e.target.dataset.removeReceipt;
    if (!id || !confirm('Remove this receipt?')) return;
    e.target.disabled = true;
    try {
        await receiptApi(`/api/receipts/${id}`, { method: 'DELETE' });
        await refreshReceipts(receiptViewerFor);
    } catch (error) {
        e.target.disabled = false;
        alert(`Receipt not removed: ${error.message}`);
    }
}

// The row picker and the viewer are the same on every page that lists
// expenses, so they are built here rather than repeated in each page's HTML.
// No capture attribute: the phone offers its camera and its photo library.
document.addEventListener('DOMContentLoaded', () => {
    document.body.insertAdjacentHTML('beforeend', `
        <input type="file" id="receipt-row-input" accept="image/*" multiple hidden>
        <div id="receipt-modal" class="modal" style="display: none;">
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Receipts</h3>
                    <span class="close" data-close="receipt-modal">&times;</span>
                </div>
                <div class="modal-body">
                    <div id="receipt-list" class="receipt-list"></div>
                    <div class="modal-actions">
                        <button type="button" id="receipt-add-btn" class="confirm-btn">📷 Add</button>
                    </div>
                </div>
            </div>
        </div>`);
    document.getElementById('receipt-row-input').addEventListener('change', handleRowReceiptPick);
    document.getElementById('receipt-add-btn').addEventListener('click', () => attachReceipt(receiptViewerFor));
    document.getElementById('receipt-list').addEventListener('click', handleReceiptRemove);
});
