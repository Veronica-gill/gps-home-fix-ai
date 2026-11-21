import { randomBytes } from 'node:crypto';
import { passwordHash } from '../auth.mjs';

const roles = { owner: ['owner', 'GPS_OWNER_PASSWORD_HASH'], technician: ['technician', 'GPS_TECH_PASSWORD_HASH'] };
const role = process.argv[2];
if (!Object.hasOwn(roles, role) || !process.stdout.isTTY) {
  console.error('Run in a private terminal: node scripts/generate-login.mjs owner|technician');
  process.exit(1);
}

const [username, variable] = roles[role];
const password = randomBytes(24).toString('base64url');
const hash = await passwordHash(password);
console.log(`Username: ${username}\nPassword: ${password}\nServer setting: ${variable}=${hash}`);
console.log('Save the password in your password manager. Configure only the hash on the server.');
