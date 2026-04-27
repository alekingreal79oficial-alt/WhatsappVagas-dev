import { sendList, sendText } from "../services/whatsapp.js";
import { sendMenuUsuario, sendActionButtons } from "./menus.js";
import {
  createPendingPayment,
  getPlanoByCodigo,
  hasPaidAccessForJobs,
} from "../lib/monetization.js";
import { createMercadoPagoPixIntent } from "../services/payments.js";




function shortTitle(value = "") {
  const text = String(value || "").trim();
  return text.length > 24 ? `${text.slice(0, 21)}...` : text;
}

function buildPreviewList(items = []) {
  return items
    .slice(0, 10)
    .map((item, index) => `${index + 1}. ${item.nome}`)
    .join("\n");
}
async function buscarVagasParaUsuario(supabase, user, limit = 30) {
  let categoriaId = user?.categoria_id || null;

  if (!categoriaId && user?.id) {
    const { data: freshUser, error: userError } = await supabase
      .from("usuarios")
      .select("categoria_id, categoria_principal, cidade, estado")
      .eq("id", user.id)
      .maybeSingle();

    if (userError) {
      console.error("❌ erro ao recarregar usuário para buscar vagas:", userError);
    } else if (freshUser) {
      categoriaId = freshUser.categoria_id || null;
      user = { ...user, ...freshUser };
    }
  }

  let query = supabase
    .from("vagas")
    .select("*")
    .eq("status", "ativa")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (categoriaId) {
    query = query.eq("categoria_id", categoriaId);
  } else if (user?.categoria_principal) {
    query = query.eq("categoria_chave", user.categoria_principal);
  }

  if (user?.cidade) {
    query = query.ilike("cidade", user.cidade);
  }

  if (user?.estado) {
    query = query.eq("estado", user.estado);
  }

  const { data, error } = await query;

  if (error) {
    console.error("❌ erro ao buscar vagas:", error);
    return { vagas: [], error };
  }

  console.log("📦 buscarVagasParaUsuario resultado:", {
    userId: user?.id,
    categoria_id: categoriaId,
    categoria_principal: user?.categoria_principal,
    cidade: user?.cidade,
    estado: user?.estado,
    total: (data || []).length,
  });

  return { vagas: data || [], error: null };
}
async function buscarTodasVagasAtivas(supabase, limit = 50) {
  const { data, error } = await supabase
    .from("vagas")
    .select("*")
    .eq("status", "ativa")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("❌ erro ao buscar todas as vagas:", error);
    return { vagas: [], error };
  }

  return { vagas: data || [], error: null };
}

function temUnlockVagas24h(user) {
  if (!user?.vagas_unlock_ate) return false;
  return new Date(user.vagas_unlock_ate) > new Date();
}

function buildTodasVagasPreview(vagas = []) {
  if (!vagas.length) return "Sem vagas disponíveis no momento.";

  const preview = vagas.slice(0, 5);
  const restante = Math.max(0, vagas.length - preview.length);

  let out = "🌍 *Vagas disponíveis no RendaJá agora:*\n";

  preview.forEach((vaga) => {
    out +=
      `\n\n• *${vaga.titulo || "Vaga"}*` +
      `\n🏢 ${vaga.nome_empresa || "Empresa não informada"}` +
      `\n📍 ${vaga.cidade || "Sem cidade"}${vaga.estado ? `/${vaga.estado}` : ""}` +
      `\n💰 ${vaga.salario || "A combinar"}`;
  });

  if (restante > 0) {
    out += `\n\n🔒 Existem mais *${restante} vaga(s)* ocultas.`;
  }

  out +=
    "\n\n💡 Ao desbloquear, você poderá:" +
    "\n• Ver a lista completa" +
    "\n• Abrir os detalhes das vagas" +
    "\n• Acessar o WhatsApp da empresa" +
    "\n• Enviar seu currículo diretamente";

  return out;
}
function formatTipoContratacao(tipo = "") {
  const map = {
    clt: "CLT",
    diaria: "Diária",
    freelance: "Freelance",
    mei: "MEI",
    meio_periodo: "Meio período",
    comissao: "Comissão",
    a_combinar: "A combinar",
  };

  return map[tipo] || tipo || "A combinar";
}

function buildJobsPreviewLocked(vagas = []) {
  if (!vagas.length) {
    return "Sem vagas no momento para seu perfil.";
  }

  const preview = vagas.slice(0, 3);
  const restante = Math.max(0, vagas.length - preview.length);

  let out = "🔎 *Encontramos vagas para o seu perfil:*\n";

  preview.forEach((vaga) => {
    out +=
      `\n\n• *${vaga.titulo || "Vaga"}*` +
      `\n🏢 ${vaga.nome_empresa || "Empresa não informada"}` +
      `\n📍 ${vaga.cidade || "Sem cidade"}${vaga.estado ? `/${vaga.estado}` : ""}` +
      `\n💰 ${vaga.salario || "A combinar"}`;
  });

  if (restante > 0) {
    out += `\n\n📌 E ainda existem *mais ${restante} oportunidade(s)* nessa busca.`;
  }
out +=
  "\n\n🔒 Você está vendo apenas as *3 primeiras vagas*." +
  "\nPara liberar a lista completa desta busca, o desbloqueio é *avulso por R$ 4,90*." +
  "\n\n📣 Se preferir, você também pode contratar um pacote de oportunidades.";
  return out;
}

function buildJobsFull(vagas = []) {
  if (!vagas.length) {
    return "Sem vagas no momento para seu perfil.";
  }

  let out = "💼 *Vagas disponíveis para você:*\n";

  vagas.forEach((vaga) => {
    out +=
      `\n\n• *${vaga.titulo || "Vaga"}*` +
      `\n🏢 ${vaga.nome_empresa || "Empresa não informada"}` +
      `\n📍 ${vaga.cidade || "Sem cidade"}${vaga.estado ? `/${vaga.estado}` : ""}` +
      `\n💰 ${vaga.salario || "A combinar"}` +
      `\n📌 ${formatTipoContratacao(vaga.tipo_contratacao)}` +
      `\n👥 ${vaga.quantidade_vagas || 1} posição(ões)`;
  });

  return out;
}
function buildJobsDetailsMessage(vaga) {
  if (!vaga) {
    return "Vaga não encontrada.";
  }

  return (
    `💼 *${vaga.titulo || "Vaga"}*\n\n` +
    `🏢 *Empresa:* ${vaga.nome_empresa || "Empresa não informada"}\n` +
    `📍 *Local:* ${vaga.cidade || "-"}${vaga.estado ? `/${vaga.estado}` : ""}\n` +
    `💰 *Salário:* ${vaga.salario || "A combinar"}\n` +
    `📌 *Contratação:* ${formatTipoContratacao(vaga.tipo_contratacao)}\n` +
    `👥 *Vagas:* ${vaga.quantidade_vagas || 1}\n` +
    `🕒 *Jornada:* ${vaga.jornada || "Não informada"}\n` +
    `✅ *Requisitos:* ${vaga.requisitos || "Não informados"}\n\n` +
    `📝 *Descrição:*\n${vaga.descricao || "Sem descrição."}`
  );
}

async function sendJobsUnlockedList(phone, vagas = []) {
  if (!vagas.length) {
    return sendText(phone, "Sem vagas no momento para seu perfil.");
  }

  return sendList(phone, "💼 Escolha uma vaga para ver os detalhes:", [
    {
      title: "Vagas disponíveis",
      rows: vagas.slice(0, 10).map((vaga) => ({
        id: `vaga_ver_${vaga.id}`,
        title: String(vaga.titulo || "Vaga").slice(0, 24),
        description: `${vaga.nome_empresa || "Empresa"} • ${vaga.cidade || "-"}`.slice(0, 72),
      })),
    },
  ]);
}
function buildPixResumo(intent, titulo, valor) {
  const checkoutUrl = intent?.checkout_url || null;

  let out =
    `💳 *Pagamento gerado com sucesso!*\n\n` +
    `📦 *Plano:* ${titulo}\n` +
    `💵 *Valor:* R$ ${Number(valor).toFixed(2)}`;

  if (checkoutUrl) {
    out += `\n\n🔗 *Link de pagamento:*\n${checkoutUrl}`;
  }

  out += `\n\n📌 *PIX copia e cola:*`;

  return out;
}

function buildPixCodeOnly(intent) {
  return intent?.qr_code || "Código Pix indisponível no momento.";
}
function getJobPackageDetails(packageId) {
  const map = {
    jobs_buy_single: {
      titulo: "Desbloqueio da busca atual",
      valor: 4.9,
      descricao:
        "Libera a lista completa da busca que você acabou de fazer. Ideal para ver todas as vagas disponíveis agora, sem assinatura.",
      confirmId: "confirm_jobs_buy_single",
      backId: "jobs_pacotes",
      backTitle: "Ver pacotes",
    },
    jobs_unlock_lista: {
  titulo: "Desbloqueio geral de vagas por 24h",
  valor: 4.9,
  descricao:
    "Libera por 24h a lista geral de vagas do RendaJá. Você poderá ver os detalhes das vagas e acessar o WhatsApp da empresa para enviar seu currículo diretamente.",
  confirmId: "confirm_jobs_unlock_lista",
  backId: "user_explorar_vagas",
  backTitle: "Explorar vagas",
},
    missoes_buy_single: {
      titulo: "Desbloqueio de missões",
      valor: 4.9,
      descricao:
        "Libera a lista completa de missões da busca atual. Ideal para ver todos os bicos disponíveis agora, sem assinatura.",
      confirmId: "confirm_missoes_buy_single",
      backId: "jobs_pacotes",
      backTitle: "Ver pacotes",
    },

    missoes_buy_month: {
      titulo: "Missões mensais",
      valor: 19.9,
      descricao:
        "Libera o acesso às missões por 30 dias e prepara seu acesso para futuras notificações desse tipo.",
      confirmId: "confirm_missoes_buy_month",
      backId: "jobs_pacotes",
      backTitle: "Ver pacotes",
    },

    jobs_missions_buy_month: {
      titulo: "Vagas + Missões mensal",
      valor: 29.9,
      descricao:
        "Libera o acesso a vagas e missões por 30 dias em um pacote combinado.",
      confirmId: "confirm_jobs_missions_buy_month",
      backId: "jobs_pacotes",
      backTitle: "Ver pacotes",
    },

    jobs_total_buy_month: {
      titulo: "Plano completo mensal",
      valor: 39.9,
      descricao:
        "Libera vagas, missões e acesso completo por 30 dias em um pacote mais amplo.",
      confirmId: "confirm_jobs_total_buy_month",
      backId: "jobs_pacotes",
      backTitle: "Ver pacotes",
    },
    jobs_buy_month_base: {
  titulo: "Notificações da minha área",
  valor: 9.9,
  descricao:
    "Você recebe notificações por 30 dias sempre que surgir vaga compatível com sua categoria.",
  confirmId: "confirm_jobs_buy_month_base",
  backId: "jobs_pacotes",
  backTitle: "Ver pacotes",
},

jobs_buy_month_plus2: {
  titulo: "Notificações + 2 categorias",
  valor: 19.9,
  descricao:
    "Você recebe notificações por 30 dias da sua categoria e de mais 2 categorias extras.",
  confirmId: "confirm_jobs_buy_month_plus2",
  backId: "jobs_pacotes",
  backTitle: "Ver pacotes",
},

jobs_buy_month_all: {
  titulo: "Notificações de todas as vagas",
  valor: 39.9,
  descricao:
    "Você recebe notificações por 30 dias de todas as vagas disponíveis.",
  confirmId: "confirm_jobs_buy_month_all",
  backId: "jobs_pacotes",
  backTitle: "Ver pacotes",
},

    job_service_buy_30d: {
      titulo: "Perfil profissional por 30 dias",
      valor: 9.9,
      descricao:
        "Seu perfil profissional ficará visível por 30 dias nas buscas de pessoas e empresas que procurarem profissionais da sua área.",
      confirmId: "confirm_job_service_buy_30d",
      backId: "prof_pacotes",
      backTitle: "Ver divulgação",
    },
job_service_highlight_7d: {
  titulo: "Destaque 7 dias",
  valor: 9.9,
  descricao:
    "Seu perfil profissional ficará em destaque por 7 dias nas buscas da sua categoria.",
  confirmId: "confirm_job_service_highlight_7d",
  backId: "prof_pacotes",
  backTitle: "Ver destaque",
},
    job_service_highlight_30d: {
      titulo: "Destaque 30 dias",
      valor: 19.9,
      descricao:
        "Seu perfil profissional ficará em destaque por 30 dias, aparecendo com prioridade nas buscas da sua área.",
      confirmId: "confirm_job_service_highlight_30d",
      backId: "prof_pacotes",
      backTitle: "Ver divulgação",
    },
  };

  return map[packageId] || null;
}

async function explicarPacoteAntesDoPagamento(phone, packageId) {
  const pkg = getJobPackageDetails(packageId);

  if (!pkg) {
    return sendText(phone, "Não encontrei os detalhes desse pacote.");
  }

  await sendText(
    phone,
    `📦 *${pkg.titulo}*\n\n` +
      `💵 *Valor:* R$ ${Number(pkg.valor).toFixed(2)}\n\n` +
      `${pkg.descricao}`
  );

  return sendActionButtons(phone, "Deseja continuar?", [
    { id: pkg.confirmId, title: "Continuar" },
    { id: pkg.backId, title: pkg.backTitle },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}
async function gerarPagamentoPix({
  supabase,
  phone,
  user,
  planoCodigo = null,
  referenciaTipo,
  tituloPlano,
  valorFinal,
  metadataExtra = {},
  afterSuccessLabel = "Acesso liberado após a aprovação do pagamento.",
  backActionId = "jobs_pacotes",
  backActionTitle = "Ver pacotes",
}) {
  let plano = null;
  let valor = Number(valorFinal || 0);
  let titulo = tituloPlano || "Plano";

  if (planoCodigo) {
    plano = await getPlanoByCodigo(supabase, planoCodigo);

    if (!plano) {
      await sendText(phone, "Plano indisponível no momento.");
      return sendActionButtons(phone, "O que deseja fazer agora?", [
        { id: backActionId, title: backActionTitle },
        { id: "voltar_menu", title: "Voltar ao menu" },
      ]);
    }

    if (!valor) valor = Number(plano.valor || 0);
    if (!tituloPlano) titulo = plano.nome;
  }

  const payment = await createPendingPayment(supabase, {
    usuarioId: user.id,
    referenciaTipo,
    planoCodigo: plano?.codigo || planoCodigo,
    valor,
    metadata: {
      telefone: user.telefone,
      cidade: user.cidade,
      estado: user.estado,
      categoria_principal: user.categoria_principal,
      ...metadataExtra,
    },
  });

  if (!payment) {
    await sendText(phone, "Erro ao gerar cobrança.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: backActionId, title: backActionTitle },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  let intent = null;
  try {
    intent = await createMercadoPagoPixIntent(payment.id);
  } catch (err) {
    console.error("❌ erro ao gerar Pix:", err);
  }

  if (!intent) {
    await sendText(
      phone,
      `💳 *Pedido criado com sucesso!*\n\n` +
        `📦 *Plano:* ${titulo}\n` +
        `💵 *Valor:* R$ ${Number(valor).toFixed(2)}\n` +
        `🆔 *Pedido:* ${payment.id}\n\n` +
        `Não consegui gerar o Pix automaticamente agora, mas o pedido foi criado.`
    );

    await sendText(phone, afterSuccessLabel);

    return sendActionButtons(phone, "Depois do pagamento:", [
      { id: "payment_check_status", title: "Já paguei" },
      { id: backActionId, title: backActionTitle },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  await sendText(phone, buildPixResumo(intent, titulo, valor));
  await sendText(phone, buildPixCodeOnly(intent));
  await sendText(phone, afterSuccessLabel);

  return sendActionButtons(phone, "Depois do pagamento:", [
    { id: "payment_check_status", title: "Já paguei" },
    { id: backActionId, title: backActionTitle },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

async function mostrarPacotesUsuario(phone) {
  return sendList(phone, "💼 *Pacotes do trabalhador*", [
    {
      title: "Categorias de pacotes",
      rows: [
        { id: "pacotes_vagas", title: "Pacotes de vagas" },
        { id: "pacotes_missoes", title: "Pacotes de missões" },
        { id: "pacotes_combinados", title: "Planos combinados" },
      ],
    },
  ]);
}

async function mostrarPacotesVagas(phone) {
  return sendList(phone, "🔔 *Pacotes de notificações*", [
    {
      title: "Notificações",
      rows: [
        { id: "jobs_buy_month_base", title: "Minha área R$9,90" },
        { id: "jobs_buy_month_plus2", title: "+2 categorias R$19,90" },
        { id: "jobs_buy_month_all", title: "Todas vagas R$39,90" },
      ],
    },
  ]);
}

async function mostrarPacotesMissoes(phone) {
  return sendList(phone, "🛠️ *Pacotes de missões*", [
    {
      title: "Missões",
      rows: [
        
        { id: "missoes_buy_month", title: "Missões mensal R$ 19,90" },
      ],
    },
  ]);
}

async function mostrarPacotesCombinados(phone) {
  return sendList(phone, "🚀 *Planos combinados*", [
    {
      title: "Combos",
   rows: [
  { id: "jobs_missions_buy_month", title: "Vagas+Missões R$29,90" },
  { id: "jobs_total_buy_month", title: "Completo R$39,90" },
],
    },
  ]);
}
async function mostrarPacotesProfissionais(phone) {
  return sendList(phone, "⭐ *Destaque profissional*", [
    {
      title: "Destaque",
      rows: [
        { id: "job_service_highlight_7d", title: "7 dias R$9,90" },
        { id: "job_service_highlight_30d", title: "30 dias R$19,90" },
      ],
    },
  ]);
}
function buildProfessionalProfileResumo(user) {
  const temPerfil =
    !!String(user?.servico_principal || "").trim() ||
    !!String(user?.descricao_perfil || "").trim();

  if (!temPerfil) {
    return (
      "🧑‍🔧 *Perfil profissional ainda não criado.*\n\n" +
      "Crie seu perfil para depois poder divulgar seu trabalho e aparecer nas buscas por profissionais."
    );
  }

  return (
    "🧑‍🔧 *Seu perfil profissional*\n\n" +
    `👤 *Nome:* ${user?.nome || "-"}\n` +
    `💼 *Serviço principal:* ${user?.servico_principal || "-"}\n` +
    `🏷️ *Área:* ${user?.area_principal || "-"}\n` +
    `📂 *Categoria:* ${user?.categoria_principal || "-"}\n` +
    `📍 *Cidade:* ${user?.cidade || "-"}${user?.estado ? `/${user.estado}` : ""}\n` +
    `💰 *Faixa de preço:* ${user?.preco_base || "A combinar"}\n` +
    `📝 *Descrição:* ${user?.descricao_perfil || "-"}\n` +
    `📞 *WhatsApp:* ${user?.telefone || "-"}`
  );
}
export async function handleJobsMenu({
  user,
  text,
  phone,
  supabase,
  updateUser,
  getCategorias,
}) {
  // =====================
  // MENU DE PACOTES
  // =====================

  if (text === "jobs_pacotes") {
  if (
    user.etapa === "jobs_week_plus2_cat_1" ||
    user.etapa === "jobs_week_plus2_cat_2" ||
    user.etapa === "jobs_month_plus2_cat_1" ||
    user.etapa === "jobs_month_plus2_cat_2"
  ) {
    await updateUser({
      etapa: "menu",
      categorias_extras_temp: [],
    });
  }

  return mostrarPacotesUsuario(phone);
}


if (text === "pacotes_vagas") {
  return mostrarPacotesVagas(phone);
}

if (text === "pacotes_missoes") {
  return mostrarPacotesMissoes(phone);
}

if (text === "pacotes_combinados") {
  return mostrarPacotesCombinados(phone);
}
if (text.startsWith("vaga_ver_")) {
  const vagaId = text.replace("vaga_ver_", "");

  const { data: vaga, error } = await supabase
    .from("vagas")
    .select("*")
    .eq("id", vagaId)
    .eq("status", "ativa")
    .maybeSingle();

  if (error || !vaga) {
    await sendText(phone, "Não consegui carregar essa vaga.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "user_ver_vagas", title: "Ver vagas" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  await sendText(phone, buildJobsDetailsMessage(vaga));

  return sendActionButtons(phone, "O que deseja fazer agora?", [
    { id: `vaga_candidatar_${vaga.id}`, title: "Candidatar-se" },
    { id: "user_ver_vagas", title: "Voltar às vagas" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

if (text.startsWith("vaga_candidatar_")) {
  const vagaId = text.replace("vaga_candidatar_", "");

  const { data: vaga, error } = await supabase
    .from("vagas")
    .select("*")
    .eq("id", vagaId)
    .eq("status", "ativa")
    .maybeSingle();

  if (error || !vaga) {
    await sendText(phone, "Não consegui localizar o contato dessa vaga.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "user_ver_vagas", title: "Ver vagas" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  const numero = String(vaga.contato_whatsapp || "").replace(/\D/g, "");
  const linkWhatsapp = numero ? `https://wa.me/${numero}` : null;

  let msg =
    `📩 *Candidatura à vaga*\n\n` +
    `💼 *Vaga:* ${vaga.titulo || "-"}\n` +
    `🏢 *Empresa:* ${vaga.nome_empresa || "Empresa não informada"}\n\n` +
    `Envie seu currículo para o contato da vaga.`;

  if (linkWhatsapp) {
    msg += `\n\n🔗 *WhatsApp da empresa:*\n${linkWhatsapp}`;
  } else {
    msg += `\n\n⚠️ O contato de WhatsApp dessa vaga não foi encontrado.`;
  }

  await sendText(phone, msg);

  return sendActionButtons(phone, "O que deseja fazer agora?", [
    { id: "user_ver_vagas", title: "Ver outras vagas" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}
if (text === "prof_pacotes") {
  const temPerfil =
    !!String(user?.servico_principal || "").trim() &&
    !!String(user?.descricao_perfil || "").trim();

  if (!temPerfil) {
    await sendText(
      phone,
      "Antes de contratar divulgação, você precisa criar seu perfil profissional."
    );

    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "prof_criar_perfil", title: "Criar perfil" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  return mostrarPacotesProfissionais(phone);
}

if (text === "prof_criar_perfil") {
  await updateUser({
    etapa: "prof_criar_perfil_servico",
  });



  user.etapa = "prof_criar_perfil_servico";

  await sendText(
    phone,
    "🧑‍🔧 *Vamos criar seu perfil profissional.*\n\nQual é o seu serviço principal?\n\nExemplo:\nVendedor externo\nEletricista residencial\nManicure\nDesigner"
  );

  return sendActionButtons(phone, "O que deseja fazer agora?", [
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

if (text === "prof_ver_perfil") {
  await sendText(phone, buildProfessionalProfileResumo(user));

  return sendActionButtons(phone, "O que deseja fazer agora?", [
    { id: "prof_criar_perfil", title: "Editar perfil" },
    { id: "prof_pacotes", title: "Ver divulgação" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

if (user.etapa === "jobs_week_plus2_cat_1") {
  if (text === "jobs_pacotes") {
    await updateUser({
      etapa: "menu",
      categorias_extras_temp: [],
    });
    return mostrarPacotesUsuario(phone);
  }

  if (text === "voltar_menu") {
    await updateUser({
      etapa: "menu",
      categorias_extras_temp: [],
    });
    return sendMenuUsuario(phone);
  }

  if (!text.startsWith("extra_cat1_")) {
    return sendText(phone, "Escolha a 1ª categoria extra na lista enviada.");
  }

  const categoriaId1 = text.replace("extra_cat1_", "");

const { data: categoria1, error: categoria1Error } = await supabase
  .from("categorias")
  .select("id, chave")
  .eq("id", categoriaId1)
  .maybeSingle();

if (categoria1Error || !categoria1?.chave) {
  await sendText(phone, "Não consegui identificar a categoria escolhida.");
  return sendActionButtons(phone, "O que deseja fazer agora?", [
    { id: "jobs_pacotes", title: "Ver pacotes" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

const cat1 = categoria1.chave;

await updateUser({
  etapa: "jobs_week_plus2_cat_2",
  categorias_extras_temp: [cat1],
});
  const { data: categorias, error } = await supabase
   .from("categorias")
.select("id, nome, chave, area_chave, ordem")
.eq("ativo", true)
.eq("area_chave", user.area_principal)
.order("ordem", { ascending: true })
.order("nome", { ascending: true })

  if (error) {
    console.error("❌ erro ao buscar 2ª categoria extra semanal:", error);
    await sendText(phone, "Erro ao carregar a 2ª categoria extra.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "jobs_pacotes", title: "Ver notificações" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }
const categoriasFiltradas = (categorias || []).filter(
  (c) => c.chave !== user.categoria_principal && c.chave !== cat1
);

await sendText(
  phone,
  `Escolha a 2ª categoria extra:\n\n${buildPreviewList(categoriasFiltradas)}\n\n👇 Toque em "Ver opções" para selecionar.`
);
  return sendList(phone, "Escolha a 2ª categoria extra:", [
  {
    title: "Categorias",
  rows: categoriasFiltradas.slice(0, 10).map((c) => ({
  id: `extra_cat2_${c.id}`,
  title: shortTitle(c.nome),
})),
  },
]);
}
if (user.etapa === "jobs_week_plus2_cat_2") {
  if (text === "jobs_pacotes") {
    await updateUser({
      etapa: "menu",
      categorias_extras_temp: [],
    });
    return mostrarPacotesUsuario(phone);
  }

  if (text === "voltar_menu") {
    await updateUser({
      etapa: "menu",
      categorias_extras_temp: [],
    });
    return sendMenuUsuario(phone);
  }

  if (!text.startsWith("extra_cat2_")) {
    return sendText(phone, "Escolha a 2ª categoria extra na lista enviada.");
  }

  const categoriaId2 = text.replace("extra_cat2_", "");

const { data: categoria2, error: categoria2Error } = await supabase
  .from("categorias")
  .select("id, chave")
  .eq("id", categoriaId2)
  .maybeSingle();

if (categoria2Error || !categoria2?.chave) {
  await sendText(phone, "Não consegui identificar a categoria escolhida.");
  return sendActionButtons(phone, "O que deseja fazer agora?", [
    { id: "jobs_pacotes", title: "Ver pacotes" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

const cat2 = categoria2.chave;
const atuais = Array.isArray(user.categorias_extras_temp)
  ? user.categorias_extras_temp
  : [];

  const categoriasExtras = Array.from(new Set([...atuais, cat2])).slice(0, 2);

  await updateUser({
    etapa: "menu",
    categorias_extras_temp: categoriasExtras,
  });

  return gerarPagamentoPix({
    supabase,
    phone,
    user: {
      ...user,
      categorias_extras_temp: categoriasExtras,
    },
    planoCodigo: "vaga_semanal_usuario",
    referenciaTipo: "usuario_vagas_semanal",
    tituloPlano: "Notificações semanais - categoria atual + 2 extras",
    valorFinal: 13.8,
    metadataExtra: {
      notificacao_scope: "mais_2",
      adicional_categorias: 2,
      categorias_extras: categoriasExtras,
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, suas notificações semanais ficarão liberadas para a categoria atual + 2 categorias extras.",
  });
}
if (user.etapa === "prof_criar_perfil_servico") {
  const servico = String(text || "").trim();

  if (!servico || servico.length < 3) {
    await sendText(
      phone,
      "Digite um serviço principal válido com pelo menos 3 caracteres.\n\nExemplo:\nVendedor externo"
    );

    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  const { error } = await supabase
    .from("usuarios")
    .update({
      servico_principal: servico,
      etapa: "prof_criar_perfil_descricao",
    })
    .eq("id", user.id);

  if (error) {
    console.error("❌ erro ao salvar serviço principal:", error);
    await sendText(phone, "Erro ao salvar seu serviço principal.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "prof_criar_perfil", title: "Tentar novamente" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  user.servico_principal = servico;
  user.etapa = "prof_criar_perfil_descricao";

  await sendText(
    phone,
    "📝 Agora descreva seu trabalho de forma curta e clara.\n\nExemplo:\nAtuo com vendas presenciais e online, atendimento ao cliente e fechamento de pedidos."
  );

  return sendActionButtons(phone, "O que deseja fazer agora?", [
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

if (user.etapa === "prof_criar_perfil_descricao") {
  const descricao = String(text || "").trim();

  if (!descricao || descricao.length < 10) {
    await sendText(
      phone,
      "Descreva melhor seu trabalho em pelo menos 10 caracteres.\n\nExemplo:\nAtuo com vendas, atendimento ao cliente e fechamento de pedidos."
    );

    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  const { error } = await supabase
    .from("usuarios")
    .update({
      descricao_perfil: descricao,
      etapa: "prof_criar_perfil_preco",
    })
    .eq("id", user.id);

  if (error) {
    console.error("❌ erro ao salvar descrição do perfil profissional:", error);
    await sendText(phone, "Erro ao salvar a descrição do seu perfil.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "prof_criar_perfil", title: "Tentar novamente" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  user.descricao_perfil = descricao;
  user.etapa = "prof_criar_perfil_preco";

  await sendText(
    phone,
    "💰 Informe sua faixa de preço ou forma de cobrança.\n\nExemplo:\nA partir de R$ 80\nDiária R$ 120\nComissão\nA combinar"
  );

  return sendActionButtons(phone, "O que deseja fazer agora?", [
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}


if (user.etapa === "prof_criar_perfil_preco") {
  const preco = String(text || "").trim();

  if (!preco || preco.length < 2) {
    await sendText(
      phone,
      "Informe uma faixa de preço válida.\n\nExemplo:\nA partir de R$ 80\nDiária R$ 120\nA combinar"
    );

    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  const { error } = await supabase
    .from("usuarios")
    .update({
      preco_base: preco,
      etapa: "menu",
    })
    .eq("id", user.id);

  if (error) {
    console.error("❌ erro ao salvar faixa de preço do perfil profissional:", error);
    await sendText(phone, "Erro ao salvar a faixa de preço do seu perfil.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "prof_criar_perfil", title: "Tentar novamente" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  user.preco_base = preco;
  user.etapa = "menu";
await supabase.from("servicos").upsert(
  {
    usuario_id: user.id,
    titulo: user.servico_principal || user.nome || "Profissional",
    descricao: user.descricao_perfil || "Profissional disponível.",
    categoria_chave: user.categoria_principal,
    cidade: user.cidade,
    estado: user.estado,
    contato_whatsapp: user.telefone,
    ativo: true,
    nivel_visibilidade: 0,
  },
  { onConflict: "usuario_id,categoria_chave" }
);
await sendText(
  phone,
  "✅ *Perfil profissional criado com sucesso!*\n\nSeu perfil já está aparecendo gratuitamente nas buscas da sua categoria.\n\nSe quiser mais visibilidade, você pode contratar destaque."
);

  await sendText(phone, buildProfessionalProfileResumo(user));

  return sendActionButtons(phone, "O que deseja fazer agora?", [
    { id: "prof_ver_perfil", title: "Ver meu perfil" },

    { id: "prof_pacotes", title: "Ver divulgação" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

  // =====================
  // VER VAGAS
  // =====================

if (text === "user_ver_vagas" || text === "user_ver_vagas_categoria") {
  const { vagas, error } = await buscarVagasParaUsuario(supabase, user, 30);

  if (error) {
    await sendText(phone, "Erro ao buscar vagas.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  if (!vagas.length) {
    await sendText(
      phone,
      "No momento não encontrei vagas na sua área específica."
    );

    return sendActionButtons(phone, "Você pode tentar:", [
      { id: "user_explorar_vagas", title: "Explorar vagas" },
      { id: "jobs_pacotes", title: "Receber alertas" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  await sendText(
    phone,
    `✅ Encontramos *${vagas.length}* vaga(s) na sua área.`
  );

  return sendJobsUnlockedList(phone, vagas);
}

if (text === "user_explorar_vagas") {
  const { vagas, error } = await buscarTodasVagasAtivas(supabase, 50);

  if (error) {
    await sendText(phone, "Erro ao buscar vagas.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  if (!vagas.length) {
    return sendText(phone, "Sem vagas disponíveis no momento.");
  }

  if (temUnlockVagas24h(user)) {
    await sendText(
      phone,
      `✅ Seu acesso geral está liberado.\n\nEncontramos *${vagas.length}* vaga(s).`
    );

    return sendJobsUnlockedList(phone, vagas);
  }

  await sendText(phone, buildTodasVagasPreview(vagas));

  return sendActionButtons(phone, "O que deseja fazer?", [
    { id: "jobs_unlock_lista", title: "Desbloquear 24h" },
    { id: "jobs_pacotes", title: "Receber alertas" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

if (text === "jobs_unlock_lista") {
  return explicarPacoteAntesDoPagamento(phone, "jobs_unlock_lista");
}

if (text === "confirm_jobs_unlock_lista") {
  return gerarPagamentoPix({
    supabase,
    phone,
    user,
    planoCodigo: "vaga_avulsa_usuario",
    referenciaTipo: "usuario_vagas_avulso_24h",
    tituloPlano: "Desbloqueio geral de vagas por 24h",
    valorFinal: 4.9,
    metadataExtra: {
      modo: "desbloqueio_geral_vagas_24h",
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, você terá 24h para ver todas as vagas e acessar o WhatsApp das empresas.",
    backActionId: "user_explorar_vagas",
    backActionTitle: "Explorar vagas",
  });
}

    
if (text === "confirm_jobs_buy_single") {
  return gerarPagamentoPix({
    supabase,
    phone,
    user,
    planoCodigo: "vaga_avulsa_usuario",
    referenciaTipo: "usuario_vagas_avulso",
    tituloPlano: "Desbloqueio da busca atual",
    valorFinal: 4.9,
    metadataExtra: {
      modo: "desbloqueio_busca_vagas",
      categoria_principal: user.categoria_principal,
      notificacao_scope: "categoria_atual",
      categorias_extras: [],
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, a lista completa desta busca ficará liberada.",
    backActionId: "user_ver_vagas",
    backActionTitle: "Ver vagas",
  });
}
if (text === "confirm_missoes_buy_single") {
  return gerarPagamentoPix({
    supabase,
    phone,
    user,
    planoCodigo: "missao_avulsa_usuario",
    referenciaTipo: "usuario_missoes_avulso",
    tituloPlano: "Desbloqueio de missões",
    valorFinal: 4.9,
    metadataExtra: {
      modo: "desbloqueio_busca_missoes",
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, a lista completa das missões ficará liberada.",
    backActionId: "user_ver_missoes",
    backActionTitle: "Ver missões",
  });
}

if (text === "confirm_missoes_buy_month") {
  return gerarPagamentoPix({
    supabase,
    phone,
    user,
    planoCodigo: "usuario_missoes_mensal",
    referenciaTipo: "usuario_missoes_mensal",
    tituloPlano: "Missões mensais",
    valorFinal: 9.9,
    metadataExtra: {
      cobertura: "missoes",
      periodicidade: "mensal",
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, seu acesso às missões ficará liberado por 30 dias.",
    backActionId: "user_ver_missoes",
    backActionTitle: "Ver missões",
  });
}

if (text === "confirm_jobs_missions_buy_month") {
  return gerarPagamentoPix({
    supabase,
    phone,
    user,
    planoCodigo: "usuario_vagas_missoes_mensal",
    referenciaTipo: "usuario_vagas_missoes_mensal",
    tituloPlano: "Vagas + Missões mensal",
    valorFinal: 29.9,
    metadataExtra: {
      cobertura: "vagas_missoes",
      periodicidade: "mensal",
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, seu acesso a vagas e missões ficará liberado por 30 dias.",
    backActionId: "jobs_pacotes",
    backActionTitle: "Ver pacotes",
  });
}

if (text === "confirm_jobs_total_buy_month") {
  return gerarPagamentoPix({
    supabase,
    phone,
    user,
    planoCodigo: "usuario_total_mensal",
    referenciaTipo: "usuario_total_mensal",
    tituloPlano: "Plano completo mensal",
    valorFinal: 39.9,
    metadataExtra: {
      cobertura: "total",
      periodicidade: "mensal",
      escopo: "todas",
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, seu acesso completo ficará liberado por 30 dias.",
    backActionId: "jobs_pacotes",
    backActionTitle: "Ver pacotes",
  });
}

if (text === "confirm_jobs_buy_week_base") {
  return gerarPagamentoPix({
    supabase,
    phone,
    user,
    planoCodigo: "vaga_semanal_usuario",
    referenciaTipo: "usuario_vagas_semanal",
    tituloPlano: "Notificações semanais - categoria atual",
    valorFinal: 9.9,
    metadataExtra: {
      notificacao_scope: "categoria_atual",
      categorias_extras: [],
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, você passará a receber notificações semanais da sua categoria atual.",
  });
}

if (text === "confirm_jobs_buy_week_plus2") {
  await updateUser({
    etapa: "jobs_week_plus2_cat_1",
    categorias_extras_temp: [],
  });

  const { data: categorias, error } = await supabase
   .from("categorias")
.select("id, nome, chave, area_chave, ordem")
.eq("ativo", true)
.eq("area_chave", user.area_principal)
.order("ordem", { ascending: true })
.order("nome", { ascending: true })

  if (error) {
    console.error("❌ erro ao buscar categorias extras semanais:", error);
    await sendText(phone, "Erro ao carregar categorias extras.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "jobs_pacotes", title: "Ver notificações" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }
const categoriasFiltradas = (categorias || []).filter(
  (c) => c.chave !== user.categoria_principal
);

await sendText(
  phone,
  `Escolha a 1ª categoria extra:\n\n${buildPreviewList(categoriasFiltradas)}\n\n👇 Toque em "Ver opções" para selecionar.`
);
return sendList(phone, "Selecione uma categoria:", [
  {
    title: "Categorias",
    rows: categoriasFiltradas.slice(0, 10).map((c) => ({
      id: `extra_cat1_${c.id}`,
      title: shortTitle(c.nome),
    })),
  },
]);
}

if (text === "confirm_jobs_buy_week_all") {
  return gerarPagamentoPix({
    supabase,
    phone,
    user,
    planoCodigo: "vaga_semanal_usuario",
    referenciaTipo: "usuario_vagas_semanal",
    tituloPlano: "Notificações semanais - todas as categorias",
    valorFinal: 17.8,
    metadataExtra: {
      notificacao_scope: "todas",
      categorias_extras: [],
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, você passará a receber notificações semanais de todas as categorias.",
  });
}

if (text === "confirm_jobs_buy_month_base") {
  return gerarPagamentoPix({
    supabase,
    phone,
    user,
    planoCodigo: "alerta_mensal_usuario",
    referenciaTipo: "usuario_alerta_mensal",
    tituloPlano: "Notificações mensais - categoria atual",
    valorFinal: 9.9,
    metadataExtra: {
      notificacao_scope: "categoria_atual",
      categorias_extras: [],
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, você passará a receber notificações mensais da sua categoria atual.",
  });
}

if (text === "confirm_jobs_buy_month_plus2") {
  await updateUser({
    etapa: "jobs_month_plus2_cat_1",
    categorias_extras_temp: [],
  });

  const { data: categorias, error } = await supabase
   .from("categorias")
.select("id, nome, chave, area_chave, ordem")
.eq("ativo", true)
.eq("area_chave", user.area_principal)
.order("ordem", { ascending: true })
.order("nome", { ascending: true })

  if (error) {
    console.error("❌ erro ao buscar categorias extras mensais:", error);
    await sendText(phone, "Erro ao carregar categorias extras.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "jobs_pacotes", title: "Ver notificações" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }
await sendText(
  phone,
  `Escolha a 1ª categoria extra:\n\n${buildPreviewList(
    (categorias || []).filter((c) => c.chave !== user.categoria_principal)
  )}\n\n👇 Toque em "Ver opções" para selecionar.`
);
  return sendList(phone, "Selecione uma categoria:", [
    {
      title: "Categorias",
      rows: (categorias || [])
        .filter((c) => c.chave !== user.categoria_principal)
        .slice(0, 10)
        .map((c) => ({
          id: `month_extra_cat1_${c.id}`,
          title: shortTitle(c.nome),
        })),
    },
  ]);
}

if (user.etapa === "jobs_month_plus2_cat_1") {
  if (text === "jobs_pacotes") {
    await updateUser({
      etapa: "menu",
      categorias_extras_temp: [],
    });
    return mostrarPacotesUsuario(phone);
  }

  if (text === "voltar_menu") {
    await updateUser({
      etapa: "menu",
      categorias_extras_temp: [],
    });
    return sendMenuUsuario(phone);
  }

  if (!text.startsWith("month_extra_cat1_")) {
    return sendText(phone, "Escolha a 1ª categoria extra na lista enviada.");
  }

  const categoriaId1 = text.replace("month_extra_cat1_", "");

const { data: categoria1, error: categoria1Error } = await supabase
  .from("categorias")
  .select("id, chave")
  .eq("id", categoriaId1)
  .maybeSingle();

if (categoria1Error || !categoria1?.chave) {
  await sendText(phone, "Não consegui identificar a categoria escolhida.");
  return sendActionButtons(phone, "O que deseja fazer agora?", [
    { id: "jobs_pacotes", title: "Ver pacotes" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

const cat1 = categoria1.chave;

await updateUser({
  etapa: "jobs_month_plus2_cat_2",
  categorias_extras_temp: [cat1],
});

  const { data: categorias, error } = await supabase
   .from("categorias")
.select("id, nome, chave, area_chave, ordem")
.eq("ativo", true)
.eq("area_chave", user.area_principal)
.order("ordem", { ascending: true })
.order("nome", { ascending: true })

  if (error) {
    console.error("❌ erro ao buscar 2ª categoria extra mensal:", error);
    await sendText(phone, "Erro ao carregar a 2ª categoria extra.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "jobs_pacotes", title: "Ver notificações" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  const categoriasFiltradas = (categorias || []).filter(
  (c) => c.chave !== user.categoria_principal && c.chave !== cat1
);

await sendText(
  phone,
  `Escolha a 2ª categoria extra:\n\n${buildPreviewList(categoriasFiltradas)}\n\n👇 Toque em "Ver opções" para selecionar.`
);

return sendList(phone, "Selecione uma categoria:", [
  {
    title: "Categorias",
    rows: categoriasFiltradas.slice(0, 10).map((c) => ({
      id: `month_extra_cat2_${c.id}`,
      title: shortTitle(c.nome),
    })),
  },
]);
}

if (user.etapa === "jobs_month_plus2_cat_2") {
  if (text === "jobs_pacotes") {
    await updateUser({
      etapa: "menu",
      categorias_extras_temp: [],
    });
    return mostrarPacotesUsuario(phone);
  }

  if (text === "voltar_menu") {
    await updateUser({
      etapa: "menu",
      categorias_extras_temp: [],
    });
    return sendMenuUsuario(phone);
  }

  if (!text.startsWith("month_extra_cat2_")) {
    return sendText(phone, "Escolha a 2ª categoria extra na lista enviada.");
  }

  const categoriaId2 = text.replace("month_extra_cat2_", "");

const { data: categoria2, error: categoria2Error } = await supabase
  .from("categorias")
  .select("id, chave")
  .eq("id", categoriaId2)
  .maybeSingle();

if (categoria2Error || !categoria2?.chave) {
  await sendText(phone, "Não consegui identificar a categoria escolhida.");
  return sendActionButtons(phone, "O que deseja fazer agora?", [
    { id: "jobs_pacotes", title: "Ver pacotes" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

const cat2 = categoria2.chave;
const atuais = Array.isArray(user.categorias_extras_temp)
  ? user.categorias_extras_temp
  : [];

  const categoriasExtras = Array.from(new Set([...atuais, cat2])).slice(0, 2);

  await updateUser({
    etapa: "menu",
    categorias_extras_temp: categoriasExtras,
  });

  return gerarPagamentoPix({
    supabase,
    phone,
    user: {
      ...user,
      categorias_extras_temp: categoriasExtras,
    },
    planoCodigo: "alerta_mensal_usuario",
    referenciaTipo: "usuario_alerta_mensal",
    tituloPlano: "Notificações mensais - categoria atual + 2 extras",
    valorFinal: 19.9,
    metadataExtra: {
      notificacao_scope: "mais_2",
      adicional_categorias: 2,
      categorias_extras: categoriasExtras,
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, suas notificações mensais ficarão liberadas para a categoria atual + 2 categorias extras.",
  });
}
if (text === "confirm_jobs_buy_month_all") {
  return gerarPagamentoPix({
    supabase,
    phone,
    user,
    planoCodigo: "alerta_mensal_usuario",
    referenciaTipo: "usuario_alerta_mensal",
    tituloPlano: "Notificações mensais - todas as categorias",
    valorFinal: 39.9,
    metadataExtra: {
      notificacao_scope: "todas",
      categorias_extras: [],
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, você passará a receber notificações mensais de todas as categorias.",
  });
}

if (text === "confirm_job_service_buy_30d") {
  return gerarPagamentoPix({
    supabase,
    phone,
    user,
    planoCodigo: "profissional_anuncio_30d",
    referenciaTipo: "profissional_anuncio",
    tituloPlano: "Divulgação do meu serviço - 30 dias",
    valorFinal: 9.9,
    metadataExtra: {
      modo: "divulgacao_trabalho",
      categoria_chave: user.categoria_principal,
      contato_whatsapp: user.telefone,
      categorias_extras: [],
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, seu perfil profissional ficará visível por 30 dias nas buscas.",
      backActionId: "prof_pacotes",
      backActionTitle: "Ver divulgação",
  });
}
if (text === "job_service_highlight_7d") {
  return explicarPacoteAntesDoPagamento(phone, "job_service_highlight_7d");
}

if (text === "confirm_job_service_highlight_7d") {
  return gerarPagamentoPix({
    supabase,
    phone,
    user,
    planoCodigo: "profissional_destaque_7d",
    referenciaTipo: "profissional_destaque",
    tituloPlano: "Destaque profissional - 7 dias",
    valorFinal: 9.9,
    metadataExtra: {
      modo: "destaque_trabalho",
      dias_destaque: 7,
      categorias_extras: [],
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, seu perfil ficará em destaque por 7 dias.",
    backActionId: "prof_pacotes",
    backActionTitle: "Ver destaque",
  });
}

if (text === "confirm_job_service_highlight_30d") {
  return gerarPagamentoPix({
    supabase,
    phone,
    user,
    planoCodigo: "profissional_destaque_30d",
    referenciaTipo: "profissional_destaque",
    tituloPlano: "Destaque do meu serviço - 30 dias",
    valorFinal: 19.9,
    metadataExtra: {
      modo: "destaque_trabalho",
      categorias_extras: [],
    },
    afterSuccessLabel:
      "Assim que o pagamento for aprovado, seu perfil profissional ficará em destaque nas buscas por 30 dias.",
    backActionId: "prof_pacotes",
    backActionTitle: "Ver divulgação",
  });
}


  // =====================
  // DESBLOQUEIO AVULSO DA BUSCA
  // =====================

  if (text === "jobs_buy_single") {
  return explicarPacoteAntesDoPagamento(phone, "jobs_buy_single");
}
if (text === "missoes_buy_single") {
  return explicarPacoteAntesDoPagamento(phone, "missoes_buy_single");
}

if (text === "missoes_buy_month") {
  return explicarPacoteAntesDoPagamento(phone, "missoes_buy_month");
}

if (text === "jobs_missions_buy_month") {
  return explicarPacoteAntesDoPagamento(phone, "jobs_missions_buy_month");
}

if (text === "jobs_total_buy_month") {
  return explicarPacoteAntesDoPagamento(phone, "jobs_total_buy_month");
}
  // =====================
  // NOTIFICAÇÕES SEMANAIS
  // =====================
if (text === "jobs_buy_week_base") {
  return explicarPacoteAntesDoPagamento(phone, "jobs_buy_week_base");
}

if (text === "jobs_buy_week_plus2") {
  return explicarPacoteAntesDoPagamento(phone, "jobs_buy_week_plus2");
}

  if (text === "jobs_buy_week_all") {

  return explicarPacoteAntesDoPagamento(phone, "jobs_buy_week_all");

}



  // =====================
  // NOTIFICAÇÕES MENSAIS
  // =====================

  if (text === "jobs_buy_month_base") {

  return explicarPacoteAntesDoPagamento(phone, "jobs_buy_month_base");

}

  if (text === "jobs_buy_month_plus2") {

  return explicarPacoteAntesDoPagamento(phone, "jobs_buy_month_plus2");

}

  if (text === "jobs_buy_month_all") {

  return explicarPacoteAntesDoPagamento(phone, "jobs_buy_month_all");

}

  // =====================
  // DIVULGAR MEU TRABALHO
  // =====================

  if (text === "job_service_buy_30d") {

  return explicarPacoteAntesDoPagamento(phone, "job_service_buy_30d");

}

  if (text === "job_service_highlight_30d") {

  return explicarPacoteAntesDoPagamento(phone, "job_service_highlight_30d");

}

  return false;
}

export async function handleUserFallback(phone) {
  return sendMenuUsuario(phone);
}