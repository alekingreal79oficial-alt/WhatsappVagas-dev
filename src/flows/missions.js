import { sendList, sendText } from "../services/whatsapp.js";
import { sendActionButtons } from "./menus.js";
import {
  calcMissaoTaxa,
  calcMissaoTotal,
  createPendingPayment,
  
} from "../lib/monetization.js";
import { createMercadoPagoPixIntent } from "../services/payments.js";

function inferCategoria(text = "") {
  const t = String(text).toLowerCase();

  if (t.includes("limp") || t.includes("faxina") || t.includes("lavar") || t.includes("capin")) {
    return "limpeza";
  }
  if (t.includes("frete") || t.includes("mudan") || t.includes("transport")) {
    return "frete";
  }
  if (t.includes("pet") || t.includes("cachorro") || t.includes("passear")) {
    return "passeio_pet";
  }
  if (t.includes("jard")) {
    return "jardinagem";
  }
  if (t.includes("mont")) {
    return "montagem";
  }
  if (t.includes("entrega")) {
    return "entrega";
  }

  return "outros";
}

function buildPixResumo(intent, resumo) {
  const checkoutUrl = intent?.checkout_url || null;

  let out =
    `💳 Pagamento da missão gerado com sucesso!\n\n` +
    `Valor da missão: R$ ${resumo.valorMissao.toFixed(2)}\n` +
    `Taxa da plataforma: R$ ${resumo.taxa.toFixed(2)}\n` +
    `Urgência: R$ ${resumo.urgencia.toFixed(2)}\n` +
    `Total: R$ ${resumo.total.toFixed(2)}`;

  if (checkoutUrl) out += `\n\n🔗 Link de pagamento:\n${checkoutUrl}`;
  return out;
}

function buildPixCodeOnly(intent) {
  return intent?.qr_code || "Código Pix indisponível no momento.";
}

function statusLabel(status) {
  const map = {
    pendente_pagamento: "Pendente pagamento",
    aberta: "Aberta",
    aguardando_aprovacao_dono: "Aguardando sua aprovação",
    em_andamento: "Em andamento",
    aguardando_confirmacao_dono: "Aguardando confirmação do dono",
    aguardando_confirmacao_executor: "Aguardando confirmação do executor",
    concluida: "Concluída",
    cancelada: "Cancelada",
  };
  return map[status] || status;
}

function buildMissaoPublicaDetalhe(missao, nomeCriador = "Não informado") {
  return (
    `📌 *${missao.titulo || "Missão"}*\n\n` +
    `👤 *Solicitante:* ${nomeCriador}\n\n` +
    `📝 *Descrição:*\n${missao.descricao || "-"}\n\n` +
    `💰 *Valor:* R$ ${Number(missao.valor || 0).toFixed(2)}\n` +
    `📍 *Cidade:* ${missao.cidade || "-"}${missao.estado ? `/${missao.estado}` : ""}\n` +
    `⚡ *Status:* ${statusLabel(missao.status)}`
  );
}

function buildMissoesPreviewLocked(missoes = []) {
  if (!missoes.length) {
    return "Sem missões no momento.";
  }

  const preview = missoes.slice(0, 3);
  const restante = Math.max(0, missoes.length - preview.length);

  let out = "🛠️ *Encontramos missões para você:*\n";

  preview.forEach((missao) => {
    const nomeCriador = missao?.usuarios?.nome || "Solicitante";

    out +=
      `\n\n• *${missao.titulo || "Missão"}*` +
      `\n👤 ${nomeCriador}` +
      `\n💰 R$ ${Number(missao.valor || 0).toFixed(2)}` +
      `\n📍 ${missao.cidade || "Sem cidade"}${missao.estado ? `/${missao.estado}` : ""}`;
  });

  if (restante > 0) {
    out += `\n\n📌 E ainda existem *mais ${restante} missão(ões)* nessa busca.`;
  }

  out +=
    "\n\n🔒 Você está vendo apenas as *3 primeiras missões*." +
    "\nPara liberar a lista completa, o desbloqueio é *avulso*." +
    "\n\n📣 Se preferir, você também pode assinar um pacote de missões ou um pacote combinado.";

  return out;
}

async function sendMissoesUnlockedList(phone, missoes = []) {
  if (!missoes.length) {
    return sendText(phone, "Sem missões no momento.");
  }

  return sendList(phone, "🛠️ Escolha uma missão para ver os detalhes:", [
    {
      title: "Missões disponíveis",
      rows: missoes.slice(0, 10).map((m) => ({
        id: `missao_publica_${m.id}`,
        title: `📌 ${String(m.titulo || "Missão").slice(0, 21)}`,
        description: `💰 R$ ${Number(m.valor || 0).toFixed(2)} • 👤 ${m?.usuarios?.nome || "Solicitante"}`
          .slice(0, 72),
      })),
    },
  ]);
}

async function gerarPagamentoMissaoAvulso({ supabase, phone, user }) {
  const payment = await createPendingPayment(supabase, {
    usuarioId: user.id,
    referenciaTipo: "usuario_missoes_avulso",
    planoCodigo: "missao_avulsa_usuario",
    valor: 4.9,
    metadata: {
      modo: "desbloqueio_lista_missoes",
      cidade: user.cidade || null,
      estado: user.estado || null,
      categoria_principal: user.categoria_principal || null,
    },
  });

  if (!payment) {
    await sendText(phone, "Erro ao gerar cobrança das missões.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "user_ver_missoes", title: "Ver missões" },
      { id: "jobs_pacotes", title: "Ver pacotes" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  let intent = null;
  try {
    intent = await createMercadoPagoPixIntent(payment.id);
  } catch (err) {
    console.error("❌ erro ao gerar Pix das missões:", err);
  }

  if (!intent) {
    await sendText(
      phone,
      `💳 *Pedido criado com sucesso!*\n\n` +
        `📦 *Plano:* Desbloqueio avulso de missões\n` +
        `💵 *Valor:* R$ 4.90\n` +
        `🆔 *Pedido:* ${payment.id}\n\n` +
        `Não consegui gerar o Pix automaticamente agora, mas o pedido foi criado.`
    );

    return sendActionButtons(phone, "Depois do pagamento:", [
      { id: "payment_check_status", title: "Já paguei" },
      { id: "user_ver_missoes", title: "Ver missões" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  await sendText(
    phone,
    `💳 *Pagamento gerado com sucesso!*\n\n` +
      `📦 *Plano:* Desbloqueio avulso de missões\n` +
      `💵 *Valor:* R$ 4.90` +
      (intent?.checkout_url ? `\n\n🔗 *Link de pagamento:*\n${intent.checkout_url}` : "")
  );

  await sendText(phone, intent?.qr_code || "Código Pix indisponível no momento.");

  await sendText(
    phone,
    "✅ Assim que o pagamento for aprovado, a lista completa das missões ficará liberada."
  );

  return sendActionButtons(phone, "Depois do pagamento:", [
    { id: "payment_check_status", title: "Já paguei" },
    { id: "user_ver_missoes", title: "Ver missões" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

async function gerarPagamentoMissaoMensal({ supabase, phone, user }) {
  const payment = await createPendingPayment(supabase, {
    usuarioId: user.id,
    referenciaTipo: "usuario_missoes_mensal",
    planoCodigo: "usuario_missoes_mensal",
    valor: 19.9,
    metadata: {
      cobertura: "missoes",
      periodicidade: "mensal",
      cidade: user.cidade || null,
      estado: user.estado || null,
      categoria_principal: user.categoria_principal || null,
    },
  });

  if (!payment) {
    await sendText(phone, "Erro ao gerar cobrança do plano de missões.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "jobs_pacotes", title: "Ver pacotes" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  let intent = null;
  try {
    intent = await createMercadoPagoPixIntent(payment.id);
  } catch (err) {
    console.error("❌ erro ao gerar Pix do plano mensal de missões:", err);
  }

  if (!intent) {
    await sendText(
      phone,
      `💳 *Pedido criado com sucesso!*\n\n` +
        `📦 *Plano:* Missões mensais\n` +
        `💵 *Valor:* R$ 19.90\n` +
        `🆔 *Pedido:* ${payment.id}\n\n` +
        `Não consegui gerar o Pix automaticamente agora, mas o pedido foi criado.`
    );

    return sendActionButtons(phone, "Depois do pagamento:", [
      { id: "payment_check_status", title: "Já paguei" },
      { id: "user_ver_missoes", title: "Ver missões" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  await sendText(
    phone,
    `💳 *Pagamento gerado com sucesso!*\n\n` +
      `📦 *Plano:* Missões mensais\n` +
      `💵 *Valor:* R$ 19.90` +
      (intent?.checkout_url ? `\n\n🔗 *Link de pagamento:*\n${intent.checkout_url}` : "")
  );

  await sendText(phone, intent?.qr_code || "Código Pix indisponível no momento.");

  await sendText(
    phone,
    "✅ Assim que o pagamento for aprovado, você terá acesso às missões por 30 dias."
  );

  return sendActionButtons(phone, "Depois do pagamento:", [
    { id: "payment_check_status", title: "Já paguei" },
    { id: "user_ver_missoes", title: "Ver missões" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

async function gerarPagamentoComboVagasMissoes({ supabase, phone, user }) {
  const payment = await createPendingPayment(supabase, {
    usuarioId: user.id,
    referenciaTipo: "usuario_vagas_missoes_mensal",
    planoCodigo: "usuario_vagas_missoes_mensal",
    valor: 29.9,
    metadata: {
      cobertura: "vagas_missoes",
      periodicidade: "mensal",
      cidade: user.cidade || null,
      estado: user.estado || null,
      categoria_principal: user.categoria_principal || null,
    },
  });

  if (!payment) {
    await sendText(phone, "Erro ao gerar cobrança do plano combo.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "jobs_pacotes", title: "Ver pacotes" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  let intent = null;
  try {
    intent = await createMercadoPagoPixIntent(payment.id);
  } catch (err) {
    console.error("❌ erro ao gerar Pix do combo vagas + missões:", err);
  }

  if (!intent) {
    await sendText(
      phone,
      `💳 *Pedido criado com sucesso!*\n\n` +
        `📦 *Plano:* Vagas + Missões mensal\n` +
        `💵 *Valor:* R$ 29.90\n` +
        `🆔 *Pedido:* ${payment.id}\n\n` +
        `Não consegui gerar o Pix automaticamente agora, mas o pedido foi criado.`
    );

    return sendActionButtons(phone, "Depois do pagamento:", [
      { id: "payment_check_status", title: "Já paguei" },
      { id: "jobs_pacotes", title: "Ver pacotes" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  await sendText(
    phone,
    `💳 *Pagamento gerado com sucesso!*\n\n` +
      `📦 *Plano:* Vagas + Missões mensal\n` +
      `💵 *Valor:* R$ 29.90` +
      (intent?.checkout_url ? `\n\n🔗 *Link de pagamento:*\n${intent.checkout_url}` : "")
  );

  await sendText(phone, intent?.qr_code || "Código Pix indisponível no momento.");

  await sendText(
    phone,
    "✅ Assim que o pagamento for aprovado, você terá acesso a vagas e missões por 30 dias."
  );

  return sendActionButtons(phone, "Depois do pagamento:", [
    { id: "payment_check_status", title: "Já paguei" },
    { id: "jobs_pacotes", title: "Ver pacotes" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

async function gerarPagamentoPlanoTotal({ supabase, phone, user }) {
  const payment = await createPendingPayment(supabase, {
    usuarioId: user.id,
    referenciaTipo: "usuario_total_mensal",
    planoCodigo: "usuario_total_mensal",
    valor: 39.9,
    metadata: {
      cobertura: "total",
      periodicidade: "mensal",
      escopo: "todas",
      cidade: user.cidade || null,
      estado: user.estado || null,
      categoria_principal: user.categoria_principal || null,
    },
  });

  if (!payment) {
    await sendText(phone, "Erro ao gerar cobrança do plano completo.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "jobs_pacotes", title: "Ver pacotes" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  let intent = null;
  try {
    intent = await createMercadoPagoPixIntent(payment.id);
  } catch (err) {
    console.error("❌ erro ao gerar Pix do plano completo:", err);
  }

  if (!intent) {
    await sendText(
      phone,
      `💳 *Pedido criado com sucesso!*\n\n` +
        `📦 *Plano:* Completo mensal\n` +
        `💵 *Valor:* R$ 39.90\n` +
        `🆔 *Pedido:* ${payment.id}\n\n` +
        `Não consegui gerar o Pix automaticamente agora, mas o pedido foi criado.`
    );

    return sendActionButtons(phone, "Depois do pagamento:", [
      { id: "payment_check_status", title: "Já paguei" },
      { id: "jobs_pacotes", title: "Ver pacotes" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  await sendText(
    phone,
    `💳 *Pagamento gerado com sucesso!*\n\n` +
      `📦 *Plano:* Completo mensal\n` +
      `💵 *Valor:* R$ 39.90` +
      (intent?.checkout_url ? `\n\n🔗 *Link de pagamento:*\n${intent.checkout_url}` : "")
  );

  await sendText(phone, intent?.qr_code || "Código Pix indisponível no momento.");

  await sendText(
    phone,
    "✅ Assim que o pagamento for aprovado, você terá acesso completo a vagas e missões por 30 dias."
  );

  return sendActionButtons(phone, "Depois do pagamento:", [
    { id: "payment_check_status", title: "Já paguei" },
    { id: "jobs_pacotes", title: "Ver pacotes" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}


async function enviarMissaoParaDono(phone, missao, interessado) {
  return sendActionButtons(
    phone,
    `📩 Novo interessado na sua missão\n\nMissão: ${missao.titulo}\nInteressado: ${interessado.nome || "Usuário"}\nTelefone: ${interessado.telefone}`,
    [
      { id: `missao_aprovar_${missao.id}_${interessado.id}`, title: "Aceitar executor" },
      { id: `missao_recusar_${missao.id}_${interessado.id}`, title: "Recusar" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]
  );
}

export async function handleMissions({
  user,
  text,
  phone,
  supabase,
  updateUser,
}) {
  // =====================
  // LISTA PÚBLICA DE MISSÕES
  // =====================



// ATIVAR PACOTE AVULSO DE MISSOES 


  {/* const paidAccess = await hasPaidAccessForMissions(supabase, user.id);
if (text === "missoes_buy_single") {
  return gerarPagamentoMissaoAvulso({
    supabase,
    phone,
    user,
  });
} */}

if (text === "user_ver_missoes") {
  const { data: missoes, error } = await supabase
    .from("missoes")
    .select(`
      *,
      usuarios:usuarios!missoes_usuario_id_fkey (
        id,
        nome,
        telefone
      )
    `)
    .eq("status", "aberta")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("❌ erro ao buscar missões:", error);
    await sendText(phone, "Erro ao buscar missões.");
    return sendActionButtons(phone, [
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  if (!missoes?.length) {
    await sendText(phone, "Sem missões no momento.");
    return sendActionButtons(phone, [
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  await sendText(
    phone,
    `✅ Encontramos *${missoes.length}* missão(ões) disponíveis para você.`
  );

  return sendMissoesUnlockedList(phone, missoes);
}

  if (text.startsWith("missao_publica_")) {
    const missaoId = text.replace("missao_publica_", "");
const { data: missao, error } = await supabase
  .from("missoes")
  .select(`
    *,
    usuarios:usuarios!missoes_usuario_id_fkey (
      id,
      nome,
      telefone
    )
  `)
  .eq("id", missaoId)
  .maybeSingle();

    if (error || !missao) {
      await sendText(phone, "Missão não encontrada.");
      return sendActionButtons(phone, "O que deseja fazer agora?", [
        { id: "user_ver_missoes", title: "Ver missões" },
        { id: "voltar_menu", title: "Voltar ao menu" },
      ]);
    }

    await sendText(
  phone,
  buildMissaoPublicaDetalhe(missao, missao?.usuarios?.nome || "Não informado")
);

    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: `missao_aceitar_${missao.id}`, title: "Aceitar missão" },
      { id: "user_ver_missoes", title: "Ver missões" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  if (text.startsWith("missao_aceitar_")) {
    const missaoId = text.replace("missao_aceitar_", "");

    const { data: missao, error } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .maybeSingle();

    if (error || !missao) {
      return sendText(phone, "Missão não encontrada.");
    }

    if (missao.usuario_id === user.id) {
      return sendText(phone, "Você não pode aceitar a própria missão.");
    }

    if (missao.status !== "aberta") {
      return sendText(phone, "Essa missão não está mais disponível.");
    }

    const { error: interessadoError } = await supabase
      .from("missoes_interessados")
      .upsert(
        {
          missao_id: missao.id,
          usuario_id: user.id,
          status: "interessado",
        },
        { onConflict: "missao_id,usuario_id" }
      );

    if (interessadoError) {
      console.error("❌ erro ao registrar interessado:", interessadoError);
      return sendText(phone, "Erro ao registrar interesse na missão.");
    }

    await supabase
      .from("missoes")
      .update({ status: "aguardando_aprovacao_dono" })
      .eq("id", missao.id)
      .eq("status", "aberta");

    const { data: dono } = await supabase
      .from("usuarios")
      .select("id,nome,telefone")
      .eq("id", missao.usuario_id)
      .maybeSingle();

    if (dono?.telefone) {
      await enviarMissaoParaDono(dono.telefone, missao, {
        id: user.id,
        nome: user.nome,
        telefone: user.telefone,
      });
    }

    await sendText(
      phone,
      `✅ Seu interesse foi registrado com sucesso.\n\nAgora você já pode conversar com o dono da missão pelo número abaixo:\n${dono?.telefone || "Telefone indisponível"}`
    );

    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "user_ver_missoes", title: "Ver missões" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  if (text.startsWith("missao_aprovar_")) {
    const parts = text.split("_");
    const missaoId = parts[2];
    const executorId = parts[3];

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .maybeSingle();

    if (!missao || missao.usuario_id !== user.id) {
      return sendText(phone, "Missão não encontrada para aprovação.");
    }

    await supabase
      .from("missoes")
      .update({
        status: "em_andamento",
        executor_usuario_id: executorId,
      })
      .eq("id", missaoId);

    await supabase
      .from("missoes_interessados")
      .update({ status: "aceito" })
      .eq("missao_id", missaoId)
      .eq("usuario_id", executorId);

    await supabase
      .from("missoes_interessados")
      .update({ status: "recusado" })
      .eq("missao_id", missaoId)
      .neq("usuario_id", executorId);

    const { data: executor } = await supabase
      .from("usuarios")
      .select("telefone")
      .eq("id", executorId)
      .maybeSingle();

    if (executor?.telefone) {
      await sendActionButtons(
        executor.telefone,
        `✅ Sua execução foi aceita!\n\nMissão: ${missao.titulo}`,
        [
          { id: `missao_executor_concluir_${missao.id}`, title: "Marcar concluída" },
          { id: "voltar_menu", title: "Voltar ao menu" },
        ]
      );
    }

    return sendText(phone, "✅ Executor aceito. A missão agora está em andamento.");
  }

  if (text.startsWith("missao_recusar_")) {
    const parts = text.split("_");
    const missaoId = parts[2];
    const executorId = parts[3];

    await supabase
      .from("missoes_interessados")
      .update({ status: "recusado" })
      .eq("missao_id", missaoId)
      .eq("usuario_id", executorId);

    const { data: pendentes } = await supabase
      .from("missoes_interessados")
      .select("*")
      .eq("missao_id", missaoId)
      .eq("status", "interessado")
      .limit(1);

    if (!pendentes?.length) {
      await supabase
        .from("missoes")
        .update({ status: "aberta" })
        .eq("id", missaoId);
    }

    return sendText(phone, "Interessado recusado.");
  }

  // =====================
  // DONO: CRIAR MISSÃO
  // =====================

  if (text === "contratar_criar_missao") {
    await updateUser({
      etapa: "missao_titulo",
      missao_titulo: null,
      missao_desc: null,
      missao_valor_temp: null,
    });

    return sendText(phone, "Qual o título da missão?\nEx: Capinar jardim");
  }

  if (user.etapa === "missao_titulo") {
    if (!text || text.length < 3) {
      return sendText(phone, "Digite um título válido para a missão:");
    }

    await updateUser({
      missao_titulo: text,
      etapa: "missao_desc",
    });

    return sendText(phone, "Agora descreva melhor o que precisa:");
  }

  if (user.etapa === "missao_desc") {
    if (!text || text.length < 5) {
      return sendText(phone, "Descreva melhor a missão:");
    }

    await updateUser({
      missao_desc: text,
      etapa: "missao_valor",
    });

    return sendText(phone, "Qual valor você quer pagar?\nEx: 40");
  }

  if (user.etapa === "missao_valor") {
  const valor = Number(String(text).replace(",", "."));

  if (!valor || valor <= 0) {
    return sendText(phone, "Digite um valor válido.\nEx: 40");
  }

  await updateUser({
    etapa: "missao_tipo",
    missao_valor_temp: String(valor),
  });

  return sendActionButtons(
    phone,
    "Essa missão será:",
    [
      { id: "missao_tipo_individual", title: "Para 1 pessoa" },
      { id: "missao_tipo_campanha", title: "Para várias pessoas" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]
  );
}


if (user.etapa === "missao_tipo" && text === "missao_tipo_individual") {
  await updateUser({
    etapa: "missao_urgencia",
    missao_tipo_temp: "individual",
    vagas_total_temp: 1,
  });

  const valorBase = Number(user.missao_valor_temp || 0);
  const taxa = calcMissaoTaxa(valorBase);

  return sendActionButtons(
    phone,
    `Resumo:\n\nValor: R$ ${valorBase.toFixed(2)}\nTaxa: R$ ${taxa.toFixed(2)}\n\nAdicionar urgência?`,
    [
      { id: "missao_urgencia_sim", title: "Com urgência" },
      { id: "missao_urgencia_nao", title: "Sem urgência" },
    ]
  );
}

if (user.etapa === "missao_tipo" && text === "missao_tipo_campanha") {
  await updateUser({
    etapa: "missao_qtd_pessoas",
    missao_tipo_temp: "campanha",
  });

  return sendText(
    phone,
    "Quantas pessoas você quer atingir?\nEx: 10"
  );
}


if (user.etapa === "missao_qtd_pessoas") {
  const qtd = Number(text);

  if (!qtd || qtd <= 0) {
    return sendText(phone, "Digite um número válido.\nEx: 10");
  }

  await updateUser({
    etapa: "missao_resumo_campanha",
    vagas_total_temp: qtd,
  });

  const total = Number(user.missao_valor_temp || 0);
  const valorPorPessoa = total / qtd;

  await sendText(
    phone,
    `📊 *Resumo da campanha*\n\n` +
    `💰 Total: R$ ${total.toFixed(2)}\n` +
    `👥 Pessoas: ${qtd}\n` +
    `🎯 Por pessoa: R$ ${valorPorPessoa.toFixed(2)}`
  );

  return sendActionButtons(
    phone,
    "Deseja continuar?",
    [
      { id: "missao_confirmar_campanha", title: "Confirmar" },
      { id: "voltar_menu", title: "Cancelar" },
    ]
  );
}




  if (
    user.etapa === "missao_urgencia" &&
    ["missao_urgencia_sim", "missao_urgencia_nao"].includes(text)
  ) {
    const urgencia = text === "missao_urgencia_sim";
    const valorBase = Number(user.missao_valor_temp || 0);
    const resumo = calcMissaoTotal(valorBase, urgencia);
    const categoria = inferCategoria(user.missao_desc || user.missao_titulo || "");

    const payment = await createPendingPayment(supabase, {
      usuarioId: user.id,
      referenciaTipo: "missao_publicacao",
      planoCodigo: urgencia ? "missao_urgencia" : null,
      valor: resumo.total,
     metadata: {
  titulo: user.missao_titulo,
  descricao: user.missao_desc,

  tipo: user.missao_tipo_temp || "individual",
  vagas_total: Number(user.vagas_total_temp || 1),
  valor_total: Number(user.missao_valor_temp || 0),
  valor_por_pessoa:
    user.missao_tipo_temp === "campanha"
      ? Number(user.missao_valor_temp || 0) / Number(user.vagas_total_temp || 1)
      : Number(user.missao_valor_temp || 0),

  valor_missao: resumo.valorMissao,
  taxa_plataforma: resumo.taxa,
  urgencia,
  categoria_chave: categoria,
  cidade: user.cidade,
  estado: user.estado,
},
    });

    if (!payment) {
      await sendText(phone, "Erro ao gerar cobrança da missão.");
      return sendActionButtons(phone, "O que deseja fazer agora?", [
        { id: "contratar_criar_missao", title: "Tentar novamente" },
        { id: "voltar_menu", title: "Voltar ao menu" },
      ]);
    }

    let intent = null;
    try {
      intent = await createMercadoPagoPixIntent(payment.id);
    } catch (err) {
      console.error("❌ erro ao gerar Pix da missão:", err);
    }

    await updateUser({
      etapa: "menu",
      missao_titulo: null,
      missao_desc: null,
      missao_valor_temp: null,
    });

    if (!intent) {
      await sendText(
        phone,
        `💳 Pedido criado com sucesso!\n\nMissão: ${
          payment.metadata?.titulo || "Missão"
        }\nValor da missão: R$ ${resumo.valorMissao.toFixed(
          2
        )}\nTaxa da plataforma: R$ ${resumo.taxa.toFixed(
          2
        )}\nUrgência: R$ ${resumo.urgencia.toFixed(
          2
        )}\nTotal: R$ ${resumo.total.toFixed(2)}\nPedido: ${
          payment.id
        }\n\nNão consegui gerar o Pix automaticamente agora, mas o pedido foi criado.`
      );

      return sendActionButtons(phone, "O que deseja fazer agora?", [
        { id: "contratar_criar_missao", title: "Criar outra missão" },
        { id: "contratar_minhas_missoes", title: "Minhas missões" },
        { id: "voltar_menu", title: "Voltar ao menu" },
      ]);
    }

    await sendText(phone, buildPixResumo(intent, resumo));
    await sendText(phone, `\n\n${buildPixCodeOnly(intent)}`);

    return sendActionButtons(phone, "Depois do pagamento:", [
      { id: "payment_check_status", title: "Já paguei" },
      { id: "contratar_minhas_missoes", title: "Minhas missões" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  // =====================
  // DONO: VER MINHAS MISSÕES
  // =====================

  if (text === "contratar_minhas_missoes") {
    const { data: missoes, error } = await supabase
      .from("missoes")
      .select("*")
      .eq("usuario_id", user.id)
      .order("created_at", { ascending: false })
      .limit(15);

    if (error) {
      console.error("❌ erro ao listar minhas missões:", error);
      return sendText(phone, "Erro ao buscar suas missões.");
    }

    if (!missoes?.length) {
      await sendText(phone, "Você ainda não criou nenhuma missão.");
      return sendActionButtons(phone, "O que deseja fazer agora?", [
        { id: "contratar_criar_missao", title: "Criar missão" },
        { id: "voltar_menu", title: "Voltar ao menu" },
      ]);
    }

    return sendList(phone, "Escolha uma missão:", [
      {
        title: "Minhas missões",
        rows: missoes.map((m) => ({
          id: `minha_missao_${m.id}`,
          title: m.titulo.slice(0, 24),
          description: `${statusLabel(m.status)} - R$ ${Number(m.valor).toFixed(2)}`.slice(0, 72),
        })),
      },
    ]);
  }

  if (text.startsWith("minha_missao_")) {
    const missaoId = text.replace("minha_missao_", "");

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .eq("usuario_id", user.id)
      .maybeSingle();

    if (!missao) {
      return sendText(phone, "Missão não encontrada.");
    }

 await sendText(
  phone,
  buildMissaoPublicaDetalhe(missao, user.nome || "Você")
);
    if (missao.status === "aberta" || missao.status === "aguardando_aprovacao_dono") {
      return sendActionButtons(phone, "O que deseja fazer agora?", [
        { id: `missao_ver_interessados_${missao.id}`, title: "Ver interessados" },
        { id: `missao_cancelar_${missao.id}`, title: "Cancelar missão" },
        { id: "contratar_minhas_missoes", title: "Minhas missões" },
      ]);
    }

    if (missao.status === "em_andamento") {
      return sendActionButtons(phone, "O que deseja fazer agora?", [
        { id: `missao_dono_concluir_${missao.id}`, title: "Marcar finalizada" },
        { id: `missao_cancelar_${missao.id}`, title: "Cancelar missão" },
        { id: "contratar_minhas_missoes", title: "Minhas missões" },
      ]);
    }

    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "contratar_minhas_missoes", title: "Minhas missões" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  if (text.startsWith("missao_ver_interessados_")) {
    const missaoId = text.replace("missao_ver_interessados_", "");

    const { data: interessados } = await supabase
      .from("missoes_interessados")
      .select("id,usuario_id,status")
      .eq("missao_id", missaoId)
      .eq("status", "interessado")
      .limit(10);

    if (!interessados?.length) {
      return sendText(phone, "Ainda não há interessados nessa missão.");
    }

    const usuariosIds = interessados.map((i) => i.usuario_id);
    const { data: usuarios } = await supabase
      .from("usuarios")
      .select("id,nome,telefone")
      .in("id", usuariosIds);

    const rows = interessados.map((i) => {
      const u = (usuarios || []).find((x) => x.id === i.usuario_id);
      return {
        id: `missao_aprovar_${missaoId}_${i.usuario_id}`,
        title: (u?.nome || "Usuário").slice(0, 24),
        description: (u?.telefone || "Sem telefone").slice(0, 72),
      };
    });

    return sendList(phone, "Escolha um interessado para aceitar:", [
      {
        title: "Interessados",
        rows,
      },
    ]);
  }

  if (text.startsWith("missao_cancelar_")) {
    const missaoId = text.replace("missao_cancelar_", "");

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .eq("usuario_id", user.id)
      .maybeSingle();

    if (!missao) return sendText(phone, "Missão não encontrada.");

    if (missao.status === "em_andamento") {
      await sendText(
        phone,
        "Essa missão já está em andamento. O cancelamento exige motivo e a taxa da plataforma não será devolvida."
      );
      await updateUser({
        etapa: `missao_cancelar_motivo_${missaoId}`,
        missao_cancelamento_motivo_temp: null,
      });
      return sendText(phone, "Informe o motivo do cancelamento:");
    }

    await updateUser({
      etapa: `missao_cancelar_motivo_${missaoId}`,
      missao_cancelamento_motivo_temp: null,
    });

    return sendText(phone, "Informe o motivo do cancelamento:");
  }

  if (user.etapa?.startsWith("missao_cancelar_motivo_")) {
    const missaoId = user.etapa.replace("missao_cancelar_motivo_", "");

    if (!text || text.length < 3) {
      return sendText(phone, "Informe um motivo válido:");
    }

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .eq("usuario_id", user.id)
      .maybeSingle();

    if (!missao) {
      await updateUser({ etapa: "menu" });
      return sendText(phone, "Missão não encontrada.");
    }

    await supabase
      .from("missoes")
      .update({
        status: "cancelada",
        motivo_cancelamento: text,
        cancelada_em: new Date().toISOString(),
      })
      .eq("id", missaoId);

    await updateUser({
      etapa: "menu",
      missao_cancelamento_motivo_temp: null,
    });

    return sendText(
      phone,
      "✅ Missão cancelada.\nA taxa da plataforma permanece retida, sem devolução."
    );
  }

  // =====================
  // CONCLUSÃO
  // =====================

  if (text.startsWith("missao_executor_concluir_")) {
    const missaoId = text.replace("missao_executor_concluir_", "");

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .eq("executor_usuario_id", user.id)
      .maybeSingle();

    if (!missao) return sendText(phone, "Missão não encontrada.");

    await supabase
      .from("missoes")
      .update({
        executor_confirmou_conclusao: true,
        status: "aguardando_confirmacao_dono",
      })
      .eq("id", missaoId);

    const { data: dono } = await supabase
      .from("usuarios")
      .select("telefone")
      .eq("id", missao.usuario_id)
      .maybeSingle();

    if (dono?.telefone) {
      await sendActionButtons(
        dono.telefone,
        `📦 O executor informou que concluiu a missão "${missao.titulo}".`,
        [
          { id: `missao_dono_confirmar_${missao.id}`, title: "Confirmar conclusão" },
          { id: `missao_dono_negar_${missao.id}`, title: "Ainda não concluiu" },
          { id: "voltar_menu", title: "Voltar ao menu" },
        ]
      );
    }

    return sendText(phone, "✅ Sua conclusão foi enviada ao dono da missão.");
  }

  if (text.startsWith("missao_dono_concluir_")) {
    const missaoId = text.replace("missao_dono_concluir_", "");

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .eq("usuario_id", user.id)
      .maybeSingle();

    if (!missao) return sendText(phone, "Missão não encontrada.");

    await supabase
      .from("missoes")
      .update({
        dono_confirmou_conclusao: true,
        status: "aguardando_confirmacao_executor",
      })
      .eq("id", missaoId);

    const { data: executor } = await supabase
      .from("usuarios")
      .select("telefone")
      .eq("id", missao.executor_usuario_id)
      .maybeSingle();

    if (executor?.telefone) {
      await sendActionButtons(
        executor.telefone,
        `📦 O dono informou que a missão "${missao.titulo}" foi finalizada.`,
        [
          { id: `missao_executor_confirmar_${missao.id}`, title: "Confirmar conclusão" },
          { id: `missao_executor_negar_${missao.id}`, title: "Ainda não concluí" },
          { id: "voltar_menu", title: "Voltar ao menu" },
        ]
      );
    }

    return sendText(phone, "✅ Seu aviso de finalização foi enviado ao executor.");
  }

  if (text.startsWith("missao_dono_confirmar_")) {
    const missaoId = text.replace("missao_dono_confirmar_", "");

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .eq("usuario_id", user.id)
      .maybeSingle();

    if (!missao) return sendText(phone, "Missão não encontrada.");

    const novosDados = { dono_confirmou_conclusao: true };
    const status = missao.executor_confirmou_conclusao
      ? "concluida"
      : "aguardando_confirmacao_executor";

    novosDados.status = status;
    if (status === "concluida") {
      novosDados.concluida_em = new Date().toISOString();
    }

    await supabase.from("missoes").update(novosDados).eq("id", missaoId);

    if (status === "concluida") {
      return sendText(phone, "✅ Missão concluída com sucesso e removida da lista pública.");
    }

    return sendText(phone, "✅ Sua confirmação foi registrada.");
  }

  if (text.startsWith("missao_executor_confirmar_")) {
    const missaoId = text.replace("missao_executor_confirmar_", "");

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .eq("executor_usuario_id", user.id)
      .maybeSingle();

    if (!missao) return sendText(phone, "Missão não encontrada.");

    const novosDados = { executor_confirmou_conclusao: true };
    const status = missao.dono_confirmou_conclusao
      ? "concluida"
      : "aguardando_confirmacao_dono";

    novosDados.status = status;
    if (status === "concluida") {
      novosDados.concluida_em = new Date().toISOString();
    }

    await supabase.from("missoes").update(novosDados).eq("id", missaoId);

    if (status === "concluida") {
      return sendText(phone, "✅ Missão concluída com sucesso e removida da lista pública.");
    }

    return sendText(phone, "✅ Sua confirmação foi registrada.");
  }

  if (text.startsWith("missao_dono_negar_") || text.startsWith("missao_executor_negar_")) {
    return sendText(phone, "Entendido. A missão continua em andamento até nova confirmação.");
  }

  return false;
}