// Auth helpers, shared by every page.
//
// These were duplicated verbatim in script.js and all-expenses.js; adding a
// third page would have made three copies. Load this before the page's own
// script - classic scripts share one top-level scope.

function getAuthToken() {
    return localStorage.getItem('authToken');
}

function getAuthHeaders() {
    const token = getAuthToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

function checkAuth() {
    if (!getAuthToken()) {
        window.location.href = '/login.html';
        return false;
    }
    return true;
}

function logout() {
    localStorage.removeItem('authToken');
    window.location.href = '/login.html';
}

// Marks the tab matching the current page. Saves hand-maintaining an "active"
// class in three separate HTML files.
document.addEventListener('DOMContentLoaded', () => {
    const here = window.location.pathname.replace(/\/index\.html$/, '/');
    document.querySelectorAll('.tab-nav a').forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === here);
    });
});

window.logout = logout;
