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
// class in every HTML file.
//
// On a phone the tab bar slides sideways (style.css), so the current page's
// tab is also scrolled to the middle of the bar, where the bar's own snapping
// would rest it - otherwise the Cards page would open with its own tab out of
// sight - and the bar is told which edges have more tabs past them, which it
// fades.
document.addEventListener('DOMContentLoaded', () => {
    const here = window.location.pathname.replace(/\/index\.html$/, '/');
    document.querySelectorAll('.tab-nav a').forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === here);
    });

    const nav = document.querySelector('.tab-nav');
    if (!nav) return;

    const active = nav.querySelector('a.active');
    if (active) {
        const navBox = nav.getBoundingClientRect();
        const tabBox = active.getBoundingClientRect();
        nav.scrollLeft += (tabBox.left + tabBox.width / 2) - (navBox.left + navBox.width / 2);
    }

    const markEdges = () => {
        nav.classList.toggle('more-left', nav.scrollLeft > 1);
        nav.classList.toggle('more-right', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1);
    };
    nav.addEventListener('scroll', markEdges, { passive: true });
    window.addEventListener('resize', markEdges);
    markEdges();
});

window.logout = logout;
