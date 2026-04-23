import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MapleCommon } from './maple-common';

describe('MapleCommon', () => {
  let component: MapleCommon;
  let fixture: ComponentFixture<MapleCommon>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MapleCommon],
    }).compileComponents();

    fixture = TestBed.createComponent(MapleCommon);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
