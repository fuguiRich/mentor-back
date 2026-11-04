import { deriveMentorType, isMentorPersonType } from './person-type';

describe('person-type', () => {
  it('teacher 是导师，且算校内', () => {
    expect(isMentorPersonType('teacher')).toBe(true);
    expect(deriveMentorType('teacher')).toBe('internal');
  });

  it('student 不是导师', () => {
    expect(isMentorPersonType('student')).toBe(false);
  });

  it('externalMentor 算校外', () => {
    expect(deriveMentorType('externalMentor')).toBe('external');
  });
});
