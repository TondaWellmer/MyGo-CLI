'use strict';

const fs = require('fs');
const path = require('path');

const TOGGLES_PATH = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'skill-toggles.json');

const CATEGORY_RULES = [
  { pattern: /^safeminds/, project: 'Safeminds', type: 'Plattformen' },
  { pattern: /^trading/, project: 'Trading', type: 'Tools' },
  { pattern: /^4based|^fourbased/, project: 'Chatbot-Platform', type: 'Plattformen' },
  { pattern: /^fanvue/, project: 'Chatbot-Platform', type: 'Plattformen' },
  { pattern: /^chatbot/, project: 'Chatbot-Platform', type: 'Tools' },
  { pattern: /^content|^social/, project: 'Chatbot-Platform', type: 'Tools' },
  { pattern: /^revenue|^safety|^brevo/, project: 'Chatbot-Platform', type: 'Infra' },
  { pattern: /^pangea|^browser/, project: 'Pangea', type: 'Tools' },
  { pattern: /^instagram|^youtube/, project: 'Chatbot-Platform', type: 'Tools' },
  { pattern: /^hetzner|^security|^deploy/, project: 'Global', type: 'Infra' },
  { pattern: /^superpowers:/, project: 'Plugins', type: 'Workflows' },
  { pattern: /^codex:/, project: 'Plugins', type: 'Workflows' },
  { pattern: /^skill-creator:/, project: 'Plugins', type: 'Workflows' },
  { pattern: /^deep-research|^dream|^loop|^schedule/, project: 'Global', type: 'Workflows' },
  { pattern: /^claude-api|^n8n|^voice|^wordpress/, project: 'Global', type: 'Tools' },
];

function findPluginSkillDirs() {
  const pluginCache = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'plugins', 'cache');
  const dirs = [];
  if (!fs.existsSync(pluginCache)) return dirs;
  try {
    for (const org of fs.readdirSync(pluginCache)) {
      const orgPath = path.join(pluginCache, org);
      if (!fs.statSync(orgPath).isDirectory()) continue;
      for (const plugin of fs.readdirSync(orgPath)) {
        const pluginPath = path.join(orgPath, plugin);
        if (!fs.statSync(pluginPath).isDirectory()) continue;
        for (const version of fs.readdirSync(pluginPath)) {
          const skillsDir = path.join(pluginPath, version, 'skills');
          if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
            dirs.push(skillsDir);
          }
        }
      }
    }
  } catch (_) {}
  return dirs;
}

function categorizeSkill(skillName) {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(skillName)) return { project: rule.project, type: rule.type };
  }
  return { project: 'Global', type: 'Tools' };
}

function readToggles() {
  try {
    if (fs.existsSync(TOGGLES_PATH)) return JSON.parse(fs.readFileSync(TOGGLES_PATH, 'utf-8'));
  } catch (_) {}
  return { disabled: [], categories: {} };
}

function writeToggles(toggles) {
  const dir = path.dirname(TOGGLES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOGGLES_PATH, JSON.stringify(toggles, null, 2), 'utf-8');
}

function scanSkillDir(dirPath, source) {
  const skills = [];
  if (!fs.existsSync(dirPath)) return skills;
  try {
    for (const entry of fs.readdirSync(dirPath)) {
      const entryPath = path.join(dirPath, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;
      const skillMd = path.join(entryPath, 'SKILL.md');
      const skillMdOff = path.join(entryPath, 'SKILL.md.off');
      let filePath = null, enabled = false;
      if (fs.existsSync(skillMd)) { filePath = skillMd; enabled = true; }
      else if (fs.existsSync(skillMdOff)) { filePath = skillMdOff; enabled = false; }
      if (!filePath) continue;
      let description = '';
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const descMatch = content.match(/^description:\s*(.+)$/m);
        if (descMatch) description = descMatch[1].trim();
      } catch (_) {}
      let skillName = entry;
      if (source === 'plugin') {
        const pluginMatch = dirPath.match(/cache[/\\]([^/\\]+)[/\\]([^/\\]+)/);
        if (pluginMatch) skillName = `${pluginMatch[2]}:${entry}`;
      }
      skills.push({ name: skillName, description, dirPath: entryPath, skillFilePath: filePath, enabled, source });
    }
  } catch (_) {}
  return skills;
}

function listAllSkills() {
  const toggles = readToggles();
  const allSkills = [];
  const userDir = path.join(process.env.USERPROFILE || process.env.HOME, 'Documents', 'Antigravity-Projects', '_skills');
  allSkills.push(...scanSkillDir(userDir, 'user'));
  const liveDir = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'skills');
  allSkills.push(...scanSkillDir(liveDir, 'live'));
  for (const pluginDir of findPluginSkillDirs()) {
    allSkills.push(...scanSkillDir(pluginDir, 'plugin'));
  }
  const seen = new Map();
  for (const skill of allSkills) {
    const existing = seen.get(skill.name);
    if (!existing || (skill.source === 'user' && existing.source === 'live')) {
      seen.set(skill.name, skill);
    }
  }
  const deduped = [];
  for (const skill of seen.values()) {
    const cat = toggles.categories?.[skill.name] || categorizeSkill(skill.name);
    deduped.push({ name: skill.name, description: skill.description, enabled: skill.enabled, project: cat.project, type: cat.type, source: skill.source, dirPath: skill.dirPath });
  }
  deduped.sort((a, b) => a.project.localeCompare(b.project) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return deduped;
}

function toggleSkill(skillName, enabled) {
  const skills = listAllSkills();
  const skill = skills.find(s => s.name === skillName);
  if (!skill) return { success: false, error: `Skill "${skillName}" not found` };
  const skillMd = path.join(skill.dirPath, 'SKILL.md');
  const skillMdOff = path.join(skill.dirPath, 'SKILL.md.off');
  try {
    if (enabled && fs.existsSync(skillMdOff)) fs.renameSync(skillMdOff, skillMd);
    else if (!enabled && fs.existsSync(skillMd)) fs.renameSync(skillMd, skillMdOff);
  } catch (err) { return { success: false, error: err.message }; }
  const toggles = readToggles();
  if (enabled) { toggles.disabled = (toggles.disabled || []).filter(n => n !== skillName); }
  else { if (!toggles.disabled) toggles.disabled = []; if (!toggles.disabled.includes(skillName)) toggles.disabled.push(skillName); }
  writeToggles(toggles);
  return { success: true, name: skillName, enabled };
}

function toggleCategory(project, type, enabled) {
  const skills = listAllSkills();
  const matching = skills.filter(s => s.project === project && (!type || s.type === type));
  const results = matching.map(s => toggleSkill(s.name, enabled));
  return { toggled: results.filter(r => r.success).length, total: matching.length };
}

function syncToggles() {
  const toggles = readToggles();
  let synced = 0;
  for (const skillName of (toggles.disabled || [])) {
    const result = toggleSkill(skillName, false);
    if (result.success) synced++;
  }
  return { synced };
}

module.exports = { listAllSkills, toggleSkill, toggleCategory, syncToggles, readToggles, writeToggles };
