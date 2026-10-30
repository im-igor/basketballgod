/** Show card totals in the background; keep detailed pages lazy. */
export const PAYOUT_LOADER_SCRIPT = `
    var queue = Promise.resolve();
    document.querySelectorAll('[data-payout-auto], details[data-payout-url]').forEach(function(details) {
      var automatic = details.dataset.payoutAuto !== undefined;
      var loaded = false, loading = false;
      async function load() {
        if (loaded || loading || (!automatic && !details.open)) return;
        loading = true;
        var content = automatic ? details : details.querySelector('[data-payout-content]');
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
      if (automatic) queue = queue.then(load);
      else details.addEventListener('toggle', load);
    });
`;
