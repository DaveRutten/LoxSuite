// Access Roles per module: the energy pages used to hang off the 'miniservers' area. Each role gets
// the new areas (energy, vehicles, charging, energy_manager, ocpp) with the same view/edit it had on
// 'miniservers', so nobody loses or gains access with the update. Fresh installs already have them
// from the baseline seed (rows that exist are left alone).
const AREAS = ['energy', 'vehicles', 'charging', 'energy_manager', 'ocpp'];

exports.up = async function up(knex) {
  const roles = await knex('access_roles').select('id', 'is_admin');
  for (const role of roles) {
    const base = await knex('access_role_permissions').where({ role_id: role.id, area: 'miniservers' }).first();
    for (const area of [...AREAS, 'translations']) {
      const exists = await knex('access_role_permissions').where({ role_id: role.id, area }).first();
      if (exists) continue;
      const fromBase = area !== 'translations';
      const view = role.is_admin ? 1 : (fromBase && base ? Number(base.can_view) || 0 : 0);
      const edit = role.is_admin ? 1 : (fromBase && base ? Number(base.can_edit) || 0 : 0);
      await knex('access_role_permissions').insert({ role_id: role.id, area, can_view: view, can_edit: edit });
    }
  }
};

exports.down = async function down(knex) {
  await knex('access_role_permissions').whereIn('area', [...AREAS, 'translations']).del();
};
