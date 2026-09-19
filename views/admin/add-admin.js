  const errorBanner = document.getElementById('errorBanner');
  const successBanner = document.getElementById('successBanner');
  const form = document.getElementById('addAdminForm');
  const newAdminIdInput = document.getElementById('newAdminId');
  const newAdminPasswordInput = document.getElementById('newAdminPassword');
  const submitBtn = form.querySelector('.submit-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBanner.style.display = 'none';
    successBanner.style.display = 'none';
    if (!newAdminIdInput.value.trim() || !newAdminPasswordInput.value) {
      errorBanner.textContent = 'Please fill in both the admin ID and password.';
      errorBanner.style.display = 'block';
      return;
    }
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';
    try {
      // A plain fetch() here — /assets/auth.js has already patched
      // window.fetch on this page to attach this tab's admin
      // Authorization header automatically.
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newAdminId: newAdminIdInput.value.trim(),
          newAdminPassword: newAdminPasswordInput.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      successBanner.textContent = 'New admin added successfully.';
      successBanner.style.display = 'block';
      form.reset();
    } catch (err) {
      errorBanner.textContent = err.message;
      errorBanner.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });
