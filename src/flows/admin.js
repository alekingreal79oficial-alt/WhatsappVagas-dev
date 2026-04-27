import { sendList, sendText } from "../services/whatsapp.js";
import { sendActionButtons } from "./menus.js";

function money(value = 0) {
  return Number(value || 0).toFixed(2);
}

function shortTitle(value = "") {
  const text = String(value || "").trim();
  return text.length > 24 ? `${text.slice(0, 21)}...` : text;
}

function shortDesc(value = "") {
  return String(value || "").slice(0, 72);
}

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
  } catch {
    return "-";
  }
}

async function sendAdminMenu(phone) {
  return sendList(phone, "🛠️ *Menu Admin RendaJá*", [
    {
      title: "Painel",
      rows: [
        { id: "admin_usuarios", title: "Usuários" },
        { id: "admin_vagas", title: "Vagas" },
        { id: "admin_financeiro", title: "Financeiro" },
        { id: "admin_saques", title: "Saques" },
        { id: "admin_missoes", title: "Missões" },
      ],
    },
  ]);
}

async function adminUsuarios({ phone, supabase }) {
  const { data, error } = await supabase
    .from("usuarios")
    .select("id,tipo,onboarding_finalizado");

  if (error) {
    console.error("❌ admin usuarios:", error);
    return sendText(phone, "Erro ao buscar usuários.");
  }

  const total = data?.length || 0;
  const usuarios = (data || []).filter((u) => u.tipo === "usuario").length;
  const contratantes = (data || []).filter((u) => u.tipo === "contratante").length;
  const empresas = (data || []).filter((u) => u.tipo === "empresa").length;
  const finalizados = (data || []).filter((u) => u.onboarding_finalizado).length;

  await sendText(
    phone,
    `👥 *Resumo de usuários*\n\n` +
      `Total: ${total}\n` +
      `Trabalhadores: ${usuarios}\n` +
      `Contratantes: ${contratantes}\n` +
      `Empresas: ${empresas}\n` +
      `Cadastros finalizados: ${finalizados}`
  );

  return sendActionButtons(phone, "O que deseja ver?", [
    { id: "admin_usuarios_lista_0", title: "Últimos usuários" },
    { id: "admin_menu", title: "Menu Admin" },
  ]);
}

async function adminUsuariosLista({ phone, supabase, page = 0 }) {
  const limit = 10;
  const from = page * limit;
  const to = from + limit - 1;

  const { data, error } = await supabase
    .from("usuarios")
    .select("id,nome,telefone,tipo,cidade,estado,created_at")
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    console.error("❌ admin usuarios lista:", error);
    return sendText(phone, "Erro ao listar usuários.");
  }

  if (!data?.length) {
    return sendText(phone, "Nenhum usuário encontrado nessa página.");
  }

  const rows = data.map((u) => ({
    id: `admin_user_${u.id}`,
    title: shortTitle(u.nome || u.telefone || "Usuário"),
    description: shortDesc(`${u.tipo || "-"} • ${u.telefone || "-"} • ${u.cidade || "-"}/${u.estado || "-"}`),
  }));

  rows.push({
    id: `admin_usuarios_lista_${page + 1}`,
    title: "➡️ Próxima página",
    description: "Ver mais usuários",
  });

  if (page > 0) {
    rows.push({
      id: `admin_usuarios_lista_${page - 1}`,
      title: "⬅️ Página anterior",
      description: "Voltar página",
    });
  }

  return sendList(phone, `👥 Últimos usuários — página ${page + 1}`, [
    {
      title: "Usuários",
      rows: rows.slice(0, 10),
    },
  ]);
}

async function adminUserDetalhe({ phone, supabase, userId }) {
  const { data: u, error } = await supabase
    .from("usuarios")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error || !u) {
    return sendText(phone, "Usuário não encontrado.");
  }

  return sendText(
    phone,
    `👤 *Perfil do usuário*\n\n` +
      `Nome: ${u.nome || "-"}\n` +
      `Telefone: ${u.telefone || "-"}\n` +
      `Tipo: ${u.tipo || "-"}\n` +
      `E-mail: ${u.email || "-"}\n` +
      `CPF: ${u.cpf || "-"}\n` +
      `Cidade: ${u.cidade || "-"}${u.estado ? `/${u.estado}` : ""}\n` +
      `Área: ${u.area_principal || "-"}\n` +
      `Categoria: ${u.categoria_principal || "-"}\n` +
      `Empresa: ${u.nome_empresa || "-"}\n` +
      `Serviço: ${u.servico_principal || "-"}\n` +
      `Cadastro finalizado: ${u.onboarding_finalizado ? "Sim" : "Não"}\n` +
      `Criado em: ${formatDate(u.created_at)}`
  );
}

async function adminVagas({ phone, supabase }) {
  const { data, error } = await supabase
    .from("vagas")
    .select("id,titulo,nome_empresa,cidade,estado,status,created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("❌ admin vagas:", error);
    return sendText(phone, "Erro ao buscar vagas.");
  }

  if (!data?.length) {
    return sendText(phone, "Nenhuma vaga encontrada.");
  }

  return sendList(phone, "💼 Últimas vagas publicadas", [
    {
      title: "Vagas",
      rows: data.map((v) => ({
        id: `admin_vaga_${v.id}`,
        title: shortTitle(v.titulo || "Vaga"),
        description: shortDesc(`${v.nome_empresa || "Empresa"} • ${v.status || "-"} • ${v.cidade || "-"}/${v.estado || "-"}`),
      })),
    },
  ]);
}

async function adminVagaDetalhe({ phone, supabase, vagaId }) {
  const { data: v, error } = await supabase
    .from("vagas")
    .select("*")
    .eq("id", vagaId)
    .maybeSingle();

  if (error || !v) return sendText(phone, "Vaga não encontrada.");

  return sendText(
    phone,
    `💼 *Detalhes da vaga*\n\n` +
      `Título: ${v.titulo || "-"}\n` +
      `Empresa: ${v.nome_empresa || "-"}\n` +
      `Cidade: ${v.cidade || "-"}${v.estado ? `/${v.estado}` : ""}\n` +
      `Status: ${v.status || "-"}\n` +
      `Salário: ${v.salario || "-"}\n` +
      `Contratação: ${v.tipo_contratacao || "-"}\n` +
      `Quantidade: ${v.quantidade_vagas || 1}\n` +
      `Contato: ${v.contato_whatsapp || "-"}\n\n` +
      `Descrição:\n${v.descricao || "-"}`
  );
}

async function adminFinanceiro({ phone, supabase }) {
  return sendList(phone, "💰 Financeiro", [
    {
      title: "Resumo por área",
      rows: [
        { id: "admin_fin_usuario", title: "Pacotes usuário" },
        { id: "admin_fin_profissional", title: "Pacotes profissional" },
        { id: "admin_fin_empresa", title: "Pacotes empresa" },
        { id: "admin_fin_tudo", title: "Resumo geral" },
      ],
    },
  ]);
}

function financeiroFilter(tipo) {
  if (tipo === "usuario") {
    return [
      "usuario_vagas_avulso",
      "usuario_missoes_avulso",
      "usuario_vagas_semanal",
      "usuario_alerta_mensal",
      "usuario_missoes_mensal",
      "usuario_vagas_missoes_mensal",
      "usuario_total_mensal",
    ];
  }

  if (tipo === "profissional") {
    return ["profissional_anuncio", "profissional_destaque"];
  }

  if (tipo === "empresa") {
    return ["empresa_pacote_vagas", "empresa_publicar_vaga", "empresa_destaque_vaga"];
  }

  return null;
}

async function adminFinanceiroResumo({ phone, supabase, tipo }) {
  let query = supabase
    .from("pagamentos_plataforma")
    .select("id,referencia_tipo,plano_codigo,valor,status,created_at");

  const refs = financeiroFilter(tipo);
  if (refs) query = query.in("referencia_tipo", refs);

  const { data, error } = await query;

  if (error) {
    console.error("❌ admin financeiro:", error);
    return sendText(phone, "Erro ao buscar financeiro.");
  }

  const rows = data || [];

  const pagos = rows.filter((p) => p.status === "pago");
  const pendentes = rows.filter((p) => p.status === "pendente");
  const cancelados = rows.filter((p) => ["cancelado", "expirado"].includes(p.status));

  const totalPago = pagos.reduce((s, p) => s + Number(p.valor || 0), 0);
  const totalPendente = pendentes.reduce((s, p) => s + Number(p.valor || 0), 0);

  const label =
    tipo === "usuario"
      ? "Usuários"
      : tipo === "profissional"
      ? "Profissionais"
      : tipo === "empresa"
      ? "Empresas"
      : "Geral";

  return sendText(
    phone,
    `💰 *Financeiro — ${label}*\n\n` +
      `✅ Pagos: ${pagos.length}\n` +
      `💵 Total pago: R$ ${money(totalPago)}\n\n` +
      `⏳ Pendentes: ${pendentes.length}\n` +
      `💵 Total pendente: R$ ${money(totalPendente)}\n\n` +
      `❌ Cancelados/expirados: ${cancelados.length}`
  );
}

async function adminSaques({ phone, supabase, page = 0 }) {
  const limit = 10;
  const from = page * limit;
  const to = from + limit - 1;

  const { data, error } = await supabase
    .from("saques")
    .select(`
      id,
      usuario_id,
      valor,
      chave_pix,
      chave_pix_tipo,
      status,
      created_at,
      usuarios:usuarios (
        nome,
        telefone
      )
    `)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    console.error("❌ admin saques:", error);
    return sendText(phone, "Erro ao buscar saques.");
  }

  if (!data?.length) {
    return sendText(phone, "Nenhum saque encontrado.");
  }

  const rows = data.map((s) => ({
    id: `admin_saque_${s.id}`,
    title: shortTitle(`R$ ${money(s.valor)} - ${s.status}`),
    description: shortDesc(`${s.usuarios?.nome || "Usuário"} • ${s.usuarios?.telefone || "-"}`),
  }));

  rows.push({
    id: `admin_saques_${page + 1}`,
    title: "➡️ Próxima página",
    description: "Ver mais saques",
  });

  if (page > 0) {
    rows.push({
      id: `admin_saques_${page - 1}`,
      title: "⬅️ Página anterior",
      description: "Voltar página",
    });
  }

  return sendList(phone, `💸 Saques — página ${page + 1}`, [
    {
      title: "Solicitações",
      rows: rows.slice(0, 10),
    },
  ]);
}

async function adminSaqueDetalhe({ phone, supabase, saqueId }) {
  const { data: saque, error } = await supabase
    .from("saques")
    .select(`
      *,
      usuarios:usuarios (
        nome,
        telefone
      )
    `)
    .eq("id", saqueId)
    .maybeSingle();

  if (error || !saque) return sendText(phone, "Saque não encontrado.");

  await sendText(
    phone,
    `💸 *Solicitação de saque*\n\n` +
      `Usuário: ${saque.usuarios?.nome || "-"}\n` +
      `Telefone: ${saque.usuarios?.telefone || "-"}\n` +
      `Valor: R$ ${money(saque.valor)}\n` +
      `Chave Pix: ${saque.chave_pix || "-"}\n` +
      `Tipo: ${saque.chave_pix_tipo || "-"}\n` +
      `Status: ${saque.status || "-"}\n` +
      `Criado em: ${formatDate(saque.created_at)}`
  );

  if (saque.status === "pago") {
    return sendActionButtons(phone, "Esse saque já está pago.", [
      { id: "admin_saques", title: "Ver saques" },
      { id: "admin_menu", title: "Menu Admin" },
    ]);
  }

  return sendActionButtons(phone, "Confirmar pagamento desse saque?", [
    { id: `admin_saque_pagar_${saque.id}`, title: "Marcar pago" },
    { id: "admin_saques", title: "Ver saques" },
    { id: "admin_menu", title: "Menu Admin" },
  ]);
}

async function adminSaquePagar({ phone, supabase, saqueId }) {
  const { data: saque, error } = await supabase
    .from("saques")
    .select(`
      *,
      usuarios:usuarios (
        id,
        nome,
        telefone
      )
    `)
    .eq("id", saqueId)
    .maybeSingle();

  if (error || !saque) return sendText(phone, "Saque não encontrado.");

  if (saque.status === "pago") {
    return sendText(phone, "Esse saque já foi marcado como pago.");
  }

  const comprovante =
    `💸 *Saque pago com sucesso!*\n\n` +
    `Valor: R$ ${money(saque.valor)}\n` +
    `Chave Pix: ${saque.chave_pix || "-"}\n` +
    `Status: Pago\n` +
    `Data: ${formatDate(new Date().toISOString())}\n\n` +
    `Obrigado por usar o RendaJá.`;

  await supabase
    .from("saques")
    .update({
      status: "pago",
      pago_em: new Date().toISOString(),
      processado_em: new Date().toISOString(),
      comprovante_texto: comprovante,
    })
    .eq("id", saque.id);

  await supabase
    .from("carteiras")
    .update({
      saldo_pendente: 0,
    })
    .eq("usuario_id", saque.usuario_id);

  if (saque.usuarios?.telefone) {
    await sendText(saque.usuarios.telefone, comprovante);
  }

  return sendText(phone, "✅ Saque marcado como pago e comprovante enviado ao usuário.");
}

async function adminMissoes({ phone, supabase }) {
  const { data, error } = await supabase
    .from("missoes")
    .select("id,titulo,tipo,status,valor,valor_por_pessoa,vagas_total,vagas_ocupadas,cidade,estado,created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("❌ admin missoes:", error);
    return sendText(phone, "Erro ao buscar missões.");
  }

  if (!data?.length) return sendText(phone, "Nenhuma missão encontrada.");

  return sendList(phone, "🛠️ Últimas missões", [
    {
      title: "Missões",
      rows: data.map((m) => ({
        id: `admin_missao_${m.id}`,
        title: shortTitle(m.titulo || "Missão"),
        description: shortDesc(`${m.status || "-"} • R$ ${money(m.valor_por_pessoa || m.valor)} • ${m.vagas_ocupadas || 0}/${m.vagas_total || 1}`),
      })),
    },
  ]);
}

async function adminMissaoDetalhe({ phone, supabase, missaoId }) {
  const { data: m, error } = await supabase
    .from("missoes")
    .select("*")
    .eq("id", missaoId)
    .maybeSingle();

  if (error || !m) return sendText(phone, "Missão não encontrada.");

  return sendText(
    phone,
    `🛠️ *Detalhes da missão*\n\n` +
      `Título: ${m.titulo || "-"}\n` +
      `Tipo: ${m.tipo || "individual"}\n` +
      `Status: ${m.status || "-"}\n` +
      `Valor total: R$ ${money(m.valor_total || m.valor)}\n` +
      `Valor por pessoa: R$ ${money(m.valor_por_pessoa || m.valor)}\n` +
      `Vagas: ${m.vagas_ocupadas || 0}/${m.vagas_total || 1}\n` +
      `Cidade: ${m.cidade || "-"}${m.estado ? `/${m.estado}` : ""}\n\n` +
      `Descrição:\n${m.descricao || "-"}`
  );
}

export async function handleAdminMenu({ user, text, phone, supabase }) {
  if (!user?.tipo_admin) return false;

  if (["admin_menu", "admin", "/admin"].includes(text)) {
    return sendAdminMenu(phone);
  }

  if (text === "admin_usuarios") {
    return adminUsuarios({ phone, supabase });
  }

  if (text.startsWith("admin_usuarios_lista_")) {
    const page = Number(text.replace("admin_usuarios_lista_", "")) || 0;
    return adminUsuariosLista({ phone, supabase, page });
  }

  if (text.startsWith("admin_user_")) {
    const userId = text.replace("admin_user_", "");
    return adminUserDetalhe({ phone, supabase, userId });
  }

  if (text === "admin_vagas") {
    return adminVagas({ phone, supabase });
  }

  if (text.startsWith("admin_vaga_")) {
    const vagaId = text.replace("admin_vaga_", "");
    return adminVagaDetalhe({ phone, supabase, vagaId });
  }

  if (text === "admin_financeiro") {
    return adminFinanceiro({ phone, supabase });
  }

  if (text === "admin_fin_usuario") {
    return adminFinanceiroResumo({ phone, supabase, tipo: "usuario" });
  }

  if (text === "admin_fin_profissional") {
    return adminFinanceiroResumo({ phone, supabase, tipo: "profissional" });
  }

  if (text === "admin_fin_empresa") {
    return adminFinanceiroResumo({ phone, supabase, tipo: "empresa" });
  }

  if (text === "admin_fin_tudo") {
    return adminFinanceiroResumo({ phone, supabase, tipo: "tudo" });
  }

  if (text === "admin_saques") {
    return adminSaques({ phone, supabase, page: 0 });
  }

  if (text.startsWith("admin_saques_")) {
    const page = Number(text.replace("admin_saques_", "")) || 0;
    return adminSaques({ phone, supabase, page });
  }

  if (text.startsWith("admin_saque_pagar_")) {
    const saqueId = text.replace("admin_saque_pagar_", "");
    return adminSaquePagar({ phone, supabase, saqueId });
  }

  if (text.startsWith("admin_saque_")) {
    const saqueId = text.replace("admin_saque_", "");
    return adminSaqueDetalhe({ phone, supabase, saqueId });
  }

  if (text === "admin_missoes") {
    return adminMissoes({ phone, supabase });
  }

  if (text.startsWith("admin_missao_")) {
    const missaoId = text.replace("admin_missao_", "");
    return adminMissaoDetalhe({ phone, supabase, missaoId });
  }

  return false;
}