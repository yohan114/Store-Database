// login.ts — application code for login.html.
// Compiled by `npm run build:client` to /js/login.js as a classic
// (non-module) script, so top-level declarations stay page-global and the
// HTML's inline event handlers keep resolving them.

// ===== extracted from login.html lines 105-148 =====
        const $ = (id) => document.getElementById(id);
        const showErr = (el, msg) => { el.textContent = msg; el.classList.remove('hidden'); };
        const hideErr = (el) => el.classList.add('hidden');

        $('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            hideErr($('loginError'));
            $('loginBtn').disabled = true;
            try {
                const res = await fetch('/api/login', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: $('username').value, password: $('password').value })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) { showErr($('loginError'), data.error || 'Sign in failed.'); $('loginBtn').disabled = false; return; }
                if (data.user && data.user.mustChangePassword) {
                    $('signinStep').classList.add('hidden');
                    $('changeStep').classList.remove('hidden');
                    $('newPassword').focus();
                } else {
                    window.location.href = '/item_tracker.html';
                }
            } catch (err) {
                showErr($('loginError'), 'Network error — please try again.'); $('loginBtn').disabled = false;
            }
        });

        $('changeForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            hideErr($('changeError'));
            if ($('newPassword').value !== $('confirmPassword').value) { showErr($('changeError'), 'Passwords do not match.'); return; }
            $('changeBtn').disabled = true;
            try {
                const res = await fetch('/api/account/password', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ newPassword: $('newPassword').value })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) { showErr($('changeError'), data.error || 'Could not update password.'); $('changeBtn').disabled = false; return; }
                window.location.href = '/item_tracker.html';
            } catch (err) {
                showErr($('changeError'), 'Network error — please try again.'); $('changeBtn').disabled = false;
            }
        });
