// 三页共享：主题初始化/切换与 escapeHtml，在 <head> 中同步加载
(function () {
    const theme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
})();

function updateIcon(theme) {
    const sunIcon = document.getElementById('sunIcon');
    const moonIcon = document.getElementById('moonIcon');
    if (!sunIcon || !moonIcon) return;
    if (theme === 'dark') {
        sunIcon.classList.remove('hidden');
        moonIcon.classList.add('hidden');
    } else {
        sunIcon.classList.add('hidden');
        moonIcon.classList.remove('hidden');
    }
}

function bindThemeToggle() {
    const toggle = document.getElementById('themeToggle');
    if (!toggle) return;

    updateIcon(document.documentElement.getAttribute('data-theme'));

    toggle.addEventListener('click', function () {
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        updateIcon(next);
    });
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindThemeToggle);
} else {
    bindThemeToggle();
}
