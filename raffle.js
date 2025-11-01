// raffle.js

const buyBtn = document.getElementById('buyBtn');
const statusDiv = document.getElementById('status');

// Pega o preço definido no index.html
const price = Number(document.getElementById('price').textContent);

buyBtn.addEventListener('click', async () => {
  statusDiv.textContent = "Aguarde, reservando seu número...";
  buyBtn.disabled = true; // evita clique múltiplo

  try {
    const res = await fetch('/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price })
    });

    if (!res.ok) {
      throw new Error("Servidor respondeu com erro");
    }

    const data = await res.json();

    if (!data.init_point) {
      statusDiv.textContent = "Não foi possível gerar a rifa. Tente novamente.";
      buyBtn.disabled = false;
      return;
    }

    // Exibe número reservado
    statusDiv.textContent = `Número reservado: ${data.number}. Redirecionando para pagamento...`;

    // Redireciona para o Mercado Pago
    setTimeout(() => {
      window.location.href = data.init_point;
    }, 1500);

  } catch (err) {
    console.error("Erro ao comprar rifa:", err);
    statusDiv.textContent = "Erro de conexão com o servidor. Tente novamente.";
    buyBtn.disabled = false;
  }
});
