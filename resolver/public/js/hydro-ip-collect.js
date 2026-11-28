const form = document.getElementById('register');
const message = document.getElementById('message');
const registered = document.getElementById('registered');
form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    message.textContent = '正在登记…';
    registered.textContent = '';
    try {
        const response = await fetch(location.href, {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(Object.fromEntries(new FormData(form))),
        });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error?.message || result.error || '登记失败');
        registered.textContent = result.name;
        message.textContent = `${result.ip} 已登记 · ${result.account}`;
    } catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
});
