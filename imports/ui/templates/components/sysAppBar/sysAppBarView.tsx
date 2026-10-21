import React, { Fragment, ReactNode, useContext } from 'react';
import IconButton from '@mui/material/IconButton';
import Styles from './sysAppBarStyles';
import Context, { ISysAppBarContext } from './sysAppBarContext';
import sysRoutes from '/imports/app/routes/routes';
import SysIcon from '/imports/ui/components/sysIcon/sysIcon';
import { SysNavLink } from '/imports/ui/components/sysNavLink/sysNavLink';
import SysMenu from '/imports/ui/components/sysMenu/sysMenuProvider';
import SysAvatar from '/imports/ui/components/sysAvatar/sysAvatar';
import RenderWithPermission from '/imports/security/ui/components/renderWithPermission';

interface ISysAppBar{
  logo?: ReactNode;
}

const SysAppBarView: React.FC<ISysAppBar> = ({logo}) => {
  const controller = useContext<ISysAppBarContext>(Context);
  
  return (
    <Styles.wrapper>
      <Styles.container>
        {logo}
        <Styles.navContainerDesktop>
          {controller.menuOptions.map(option => (
            <RenderWithPermission key={option?.name} resources={option?.resources}>
              <SysNavLink
                active={sysRoutes.checkIsActiveRoute(option?.path)}
                sysOptions={option!}
              />
            </RenderWithPermission>
          ))}
        </Styles.navContainerDesktop>
        <Styles.navContainerMobile>
          <Fragment>
            <Styles.iconButton aria-label="Abrir navegação" aria-haspopup="menu" onClick={controller.abrirMenuMobile}>
              <SysIcon name='menu' sx={{ width: '24px', height: '24px' }}/>
            </Styles.iconButton>
            <SysMenu
              ref={controller.menuMobileRef}
              options={controller.getOpcoesMenuMobile()}
              activeArrow
              anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
              transformOrigin={{ horizontal: 'right', vertical: 'top' }}
            />

          </Fragment>
        </Styles.navContainerMobile>
        <Fragment>
          <IconButton aria-label="Menu do usuário" aria-haspopup="menu" onClick={controller.abrirMenuPerfil} sx={{ flexShrink: 0 }}>
            <SysAvatar name={controller.userName} activateOutline size="large" />
          </IconButton>
          <SysMenu
              ref={controller.menuPerfilRef}
              options={controller.getOpcoesMenuDeUsuario()}
              activeArrow
              anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
              transformOrigin={{ horizontal: 'right', vertical: 'top' }}
            />
        </Fragment>
      </Styles.container>
    </Styles.wrapper>
  );
};

export default SysAppBarView;