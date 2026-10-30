/** Load current calendar amounts only when their section is expanded. */
export const PAYOUT_LOADER_SCRIPT = `
    document.querySelectorAll('details[data-payout-url]').forEach(function(details) {
      var loaded = false, loading = false;
      async function load() {
        if (loaded || loading || !details.open) return;
        loading = true;
        var content = details.querySelector('[data-payout-content]');
        content.innerHTML = '<p role="status">Загружаю начисления…</p>';
        try {
          var response = await fetch(details.dataset.payoutUrl, { headers: { Accept: 'text/html' } });
          if (response.redirected) throw new Error('Обнови страницу и войди в админку заново.');
          if (!response.ok) throw new Error(await response.text());
          content.innerHTML = await response.text();
          loaded = true;
        } catch (err) {
          content.textContent = err.message;
          var retry = document.createElement('button');
          retry.type = 'button'; retry.textContent = 'Повторить'; retry.addEventListener('click', load);
          content.appendChild(retry);
        } finally { loading = false; }
      }
      details.addEventListener('toggle', load);
    });
`;
