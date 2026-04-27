import { sendButtons, sendList } from "../services/whatsapp.js";

export function sendRootMenu(phone) {
  return sendButtons(
    phone,
    "🚀 Bem-vindo ao RendaJá!\n\n💸 Ganhe dinheiro, encontre profissionais ou descubra oportunidades perto de você.\n\nAqui você pode:\n💰 Trabalhar\n🧑‍🔧 Contratar\n📢 Divulgar oportunidades\n\nComo você quer usar a plataforma?",
    [
      { id: "tipo_usuario", title: "Quero trabalhar" },
      { id: "tipo_contratante", title: "Buscar profissional" },
      { id: "tipo_empresa", title: "Sou empresa" },
    ]
  );
}

export function sendMenuUsuario(phone) {
  return sendList(phone, "💼 Menu do trabalhador:", [
   {
  title: "Buscar oportunidades",
  rows: [
    { id: "user_ver_vagas", title: "📌 Vagas minha área" },
    { id: "user_explorar_vagas", title: "🌍 Todas as vagas" },
    { id: "user_ver_missoes", title: "🔥 Missões" },
    { id: "jobs_pacotes", title: "🔔 Notificações" },
  ],
},
    {
      title: "Perfil profissional",
      rows: [
        { id: "prof_criar_perfil", title: "Criar perfil" },
        { id: "prof_ver_perfil", title: "Ver meu perfil" },
        { id: "prof_pacotes", title: "Pacotes divulgação" },
      ],
    },
    {
      title: "Perfil",
      rows: [
        { id: "user_carteira", title: "Minha carteira" },
        { id: "redefinir_perfil", title: "Redefinir perfil" },
      ],
    },
  ]);
}

export function sendMenuContratante(phone) {
  return sendList(phone, "🛠️ Menu de contratação:", [
    {
      title: "Serviços",
      rows: [
        { id: "contratar_buscar_profissionais", title: "Buscar profissionais" },
        { id: "contratar_criar_missao", title: "Criar missão" },
        { id: "contratar_minhas_missoes", title: "Minhas missões" },
      ],
    },
    {
      title: "Perfil",
      rows: [
        { id: "user_carteira", title: "Minha carteira" },
        { id: "redefinir_perfil", title: "Redefinir perfil" },
      ],
    },
  ]);
}

export function sendMenuEmpresa(phone) {
  return sendList(phone, "🏢 Menu da empresa:", [
    {
      title: "Empresa",
      rows: [
        { id: "empresa_criar_vaga", title: "Criar vaga" },
        { id: "contratar_criar_missao", title: "Criar missão" },
        { id: "contratar_minhas_missoes", title: "Minhas missões" },
        { id: "empresa_pacotes", title: "Pacotes" },
        { id: "empresa_buscar_profissionais", title: "Buscar profissionais" },
        { id: "empresa_minhas_vagas", title: "Minhas vagas" },
      ],
    },
    {
      title: "Perfil",
      rows: [
        { id: "user_carteira", title: "Minha carteira" },
        { id: "redefinir_perfil", title: "Redefinir perfil" },
      ],
    },
  ]);
}

export function sendAreasPage(phone, areas = [], page = 1) {
  const PAGE_SIZE = 9;

  const safeAreas = Array.isArray(areas)
    ? areas.filter((a) => a?.chave && a?.nome)
    : [];

  const totalPages = Math.max(1, Math.ceil(safeAreas.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(Number(page) || 1, 1), totalPages);

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = safeAreas.slice(start, start + PAGE_SIZE);

  const rows = pageItems.map((area) => ({
    id: `area_${area.chave}`,
    title: String(area.nome).slice(0, 24),
  }));

  if (currentPage < totalPages) {
    rows.push({
      id: `areas_page_${currentPage + 1}`,
      title: "➡️ Próxima página",
    });
  }

  if (currentPage > 1) {
    rows.push({
      id: `areas_page_${currentPage - 1}`,
      title: "⬅️ Página anterior",
    });
  }

  return sendList(phone, `Escolha sua área de interesse (${currentPage}/${totalPages}):`, [
    {
      title: `Áreas ${currentPage}/${totalPages}`,
      rows,
    },
  ]);
}

export function sendActionButtons(phone, body, buttons) {
  return sendButtons(phone, body, buttons.slice(0, 3));
}