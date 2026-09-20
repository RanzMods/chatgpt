import { faker } from '@faker-js/faker';

export function generateProfile() {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();

  const minAge = 18;
  const maxAge = 45;
  const age = Math.floor(Math.random() * (maxAge - minAge + 1)) + minAge;
  const birthDate = faker.date.birthdate({ min: age, max: age, mode: 'age' });

  return {
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`,
    age: String(age),
    birthMonth: String(birthDate.getMonth() + 1).padStart(2, '0'),
    birthDay: String(birthDate.getDate()).padStart(2, '0'),
    birthYear: String(birthDate.getFullYear()),
  };
}
