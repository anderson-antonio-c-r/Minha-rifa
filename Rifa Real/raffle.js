document.getElementById('buyBtn').addEventListener('click', async () => {
  const price = Number(document.getElementById('price').value || 10);
  document.getElementById('result').innerText = 'Reservando número...';
  try {
    const res = await fetch('/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price })
    });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById('result').innerText = 'Erro: ' + (data.error || JSON.stringify(data));
      return;
    }
    document.getElementById('result').innerHTML = `
      Número reservado: <b>${data.number}</b><br/>
      Redirecionando para o pagamento...
      (modo: ${data.mode})
    `;
    // redireciona para o init_point retornado (sandbox ou real)
    window.location.href = data.init_point;
  } catch (err) {
    document.getElementById('result').innerText = 'Erro na requisição: ' + err;
  }
});
